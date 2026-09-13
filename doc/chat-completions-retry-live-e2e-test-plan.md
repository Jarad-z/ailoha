# Chat Completions 重试机制真实模型 E2E 测试设计

状态：Implemented v0.1

关联设计：[`basic-retry-error-handling-spec.md`](./basic-retry-error-handling-spec.md)

## 1. 测试目标

本 E2E 用真实 DeepSeek streaming 请求验证：

1. 前两次 transport attempt 遇到可重试错误后，adapter 会自动重试。
2. 最后一次 attempt 确实到达真实模型，而不是使用固定 fixture 冒充成功响应。
3. 多次 transport attempt 在 Agent Core 中仍然只是一次 LLM call/turn。
4. 对外只产生一套成功的 stream 事件，不泄漏前面失败 attempt 的错误事件或重复文本。
5. 最终回答、usage、response metadata 和 Trace 能证明真实模型调用成功。
6. API key、Authorization header 不进入日志或 artifact。

该测试是受环境变量控制的 live smoke test，不加入默认 `npm test`。它会访问外部 provider 并产生少量费用。

## 2. 为什么不等待真实 429/503

直接反复调用 provider、等待真实限流或服务故障，不适合作为 E2E：

- 无法保证什么时候出现 429/503。
- 容易因为账户配额、并发限制或 provider 状态产生误报。
- 为了触发限流而增加请求量会浪费费用。
- 很难精确断言失败顺序和 attempt 次数。

因此测试采用“故障注入 + 最后一次真实转发”：

```text
Session.agent.prompt
        |
        v
ChatCompletionsAdapter
        |
        v
instrumentedFetch
  attempt 1 -> synthetic HTTP 429
  attempt 2 -> synthetic HTTP 503
  attempt 3 -> globalThis.fetch -> real DeepSeek streaming response
        |
        v
AssistantEventStream -> Agent Core -> final answer
```

这不是 mock 整个模型边界。请求构造、错误解析、错误分类、退避、OpenAI SDK、真实 TLS/HTTP、真实 SSE、chunk 聚合、Agent 状态和 Trace 都参与执行；只有前两个明确的失败 response 是测试主动注入的。

## 3. 测试层级

### 3.1 第一阶段：Session + Adapter live E2E（必须）

新增脚本：

```text
scripts/deepseek-retry-live-e2e.mjs
```

入口使用 `Session.agent.prompt()`，复用 `scripts/deepseek-adapter-e2e-trace.mjs` 的模型配置、事件采集和 artifact 写入方式。

这是第一期的主验收测试，因为它能直接观察：

- adapter 内部的 attempt 数量；
- `onRetry` 事件；
- adapter stream 事件；
- Agent Core LLM Trace；
- 最终真实模型结果。

### 3.2 第二阶段：HTTP Service + fault proxy E2E（可选）

在第一阶段稳定后，再增加完整 HTTP 黑盒：

```text
HTTP client
  -> Agent Service
  -> ChatCompletionsAdapter
  -> localhost fault proxy
       -> 429
       -> 503
       -> real DeepSeek
```

它主要验证 composition root 是否正确启用 retry policy，以及 Service 的 Run/Operation/Transcript 语义。它不能替代第一阶段，因为跨进程后不容易精确读取 adapter 的内部 attempt 事件。

## 4. 主场景

场景名称：`429 then 503 then real model success`

### 4.1 输入

每次运行生成一个不含敏感信息的 nonce：

```js
const nonce = `RETRY_OK_${Date.now()}`;
```

System prompt：

```text
You are a live retry E2E test. Follow the user's output-format instruction exactly.
Do not call tools. Do not add explanations.
```

User prompt：

```text
只回复下面这个标记，不要添加其他内容：<nonce>
```

不注册工具，保证成功路径只需要一次 Agent LLM call，减少模型行为波动和真实调用费用。

### 4.2 故障顺序

注入的 `fetch` 按调用次数执行：

| Transport attempt | 行为 | 目的 |
| ---: | --- | --- |
| 1 | 返回 synthetic 429，带 `retry-after-ms: 25` | 验证限流分类和 provider delay |
| 2 | 返回 synthetic 503，不带 retry header | 验证 5xx 分类和本地退避 |
| 3 | 调用保存好的原始 `globalThis.fetch` | 验证真实模型 streaming 成功 |
| >3 | 立即抛出测试错误 | 防止 retry 次数失控 |

synthetic response 必须使用 provider 兼容的错误 body：

```json
{
  "error": {
    "message": "injected retry live e2e failure",
    "type": "rate_limit_error",
    "code": "rate_limit_exceeded"
  }
}
```

503 的 `type/code` 改为 `server_error`。不得把 API key 放进 synthetic body。

### 4.3 Adapter 配置

```js
const adapter = new ChatCompletionsAdapter({
  model,
  apiKey,
  fetch: instrumentedFetch,
  retry: {
    maxAttempts: 3,
    baseDelayMs: 10,
    maxDelayMs: 50,
    respectRetryAfter: true,
  },
});
```

live E2E 使用很短的退避，以降低测试耗时。默认生产参数由单元测试覆盖，不需要在 live E2E 中等待秒级时间。

## 5. `instrumentedFetch` 设计

在覆盖前保存真实 fetch，避免第三次调用递归进入自己：

```js
const upstreamFetch = globalThis.fetch.bind(globalThis);
let transportAttempts = 0;
let realUpstreamCalls = 0;

const instrumentedFetch = async (input, init) => {
  const attempt = ++transportAttempts;

  if (attempt === 1) {
    return injectedError(429, "rate_limit_exceeded", {
      "retry-after-ms": "25",
      "x-request-id": "injected-429",
    });
  }

  if (attempt === 2) {
    return injectedError(503, "server_error", {
      "x-request-id": "injected-503",
    });
  }

  if (attempt === 3) {
    realUpstreamCalls++;
    return await upstreamFetch(input, init);
  }

  throw new Error(`Unexpected transport attempt: ${attempt}`);
};
```

注意：

- 不记录 `init.headers`，因为其中包含 Authorization。
- 如需记录 URL，只记录 origin/path，不能记录 query 中可能出现的 credential。
- 不读取或复制真实 response body；直接返回给 OpenAI SDK 消费，保持 streaming。
- 测试结束后无需恢复 `globalThis.fetch`，因为没有修改全局对象，只通过 adapter 构造参数注入。

## 6. 需要采集的事件

脚本维护一条 JSONL 时间线，结构沿用现有 adapter live trace：

```ts
interface LiveRetryRecord {
  readonly sequence: number;
  readonly elapsedMs: number;
  readonly type:
    | "transport.attempt"
    | "adapter.retry"
    | "model.response"
    | "model.stream.event"
    | "agent.trace"
    | "e2e.result";
  readonly data: unknown;
}
```

输出位置：

```text
artifacts/chat-completions-retry-live-e2e.jsonl
```

建议记录：

- `transport.attempt`：attempt、注入/真实、synthetic status。
- `adapter.retry`：attempt、nextAttempt、status、reason、delayMs。
- `model.response`：最终真实 response 的 status、request ID、content type。
- `model.stream.event`：只记录 event type、terminal reason 和最终 message；delta 正文可不记录。
- `agent.trace`：完整 Core Trace event。
- `e2e.result`：断言所需汇总值。

严禁记录：

- API key。
- Authorization/Cookie。
- 完整 request headers。
- OpenAI SDK Request 对象的直接序列化结果。

## 7. 主场景断言

### 7.1 Transport/Retry 断言

```text
transportAttempts === 3
realUpstreamCalls === 1
retryEvents.length === 2
retryEvents[0] matches { attempt: 1, nextAttempt: 2, status: 429 }
retryEvents[1] matches { attempt: 2, nextAttempt: 3, status: 503 }
```

还应断言：

- 第一次 `delayMs` 使用 `retry-after-ms: 25`。
- 第二次 `delayMs` 在 `0..20ms` 范围内；若 live E2E 不注入固定 random，只断言 `0..maxDelayMs`，不要断言精确值。
- `onPayload` 恰好调用 1 次。
- `onResponse` 恰好调用 1 次，且 status 为 200。

### 7.2 Stream 断言

```text
start event count === 1
done event count === 1
error event count === 0
terminal event count === 1
```

最终 message 必须满足：

- `stopReason === "stop"`。
- text 经 trim 后包含 nonce；推荐允许 provider 偶发增加引号，不要求 byte-for-byte 完全相等。
- `responseId` 非空，或最终 200 response 含 provider request ID；至少一个真实响应标识必须存在。
- `usage.totalTokens > 0`。

### 7.3 Agent Core 断言

虽然 transport 有三次 attempt，Core 只能观察到一次逻辑 LLM call：

```text
agent.run.started count === 1
llm.call.started count === 1
llm.call.finished count === 1
context.compaction/compact events count === 0
tool.call.requested count === 0
agent.run.finished count === 1
agent.run.finished.outcome === "success"
```

同时断言 Agent `turnCount` 或等价 Trace 语义为 1，证明 adapter retry 没有消耗额外 turn budget。

### 7.4 安全断言

artifact 写入完成后读取文本并断言：

```js
if (artifact.includes(apiKey)) throw new Error("Retry E2E artifact contains API key.");
if (/authorization|bearer\s+/iu.test(artifact)) {
  throw new Error("Retry E2E artifact contains authorization material.");
}
```

`authorization` 字样如果仅用于安全扫描报告也会触发，因此 artifact 本身不要写字段名或扫描规则，只输出布尔汇总，例如 `containsSecrets: false`。

## 8. 失败与清理行为

- 整个脚本设置 120 秒 hard timeout，超时后 abort 当前 Session/adapter 请求。
- `finally` 中始终调用 `session.dispose()`。
- 失败时仍尝试写出已收集的安全 records，便于定位最后一个 attempt。
- assertion error 必须让进程以非零状态退出。
- 不把测试失败自动再运行一遍；否则会掩盖 retry 逻辑本身的问题并增加真实调用。
- 不把真实 provider 的偶发内容差异误判为 retry 错误；核心成功判据是 nonce、usage、200 response 和 Trace 生命周期共同成立。

## 9. 命令与环境变量

`package.json` 增加：

```json
{
  "scripts": {
    "test:e2e:retry-live": "npm run build && node --env-file-if-exists=.env.local scripts/deepseek-retry-live-e2e.mjs"
  }
}
```

必需环境变量：

```text
DEEPSEEK_API_KEY
```

可选环境变量：

```text
DEEPSEEK_MODEL       默认 deepseek-v4-flash
DEEPSEEK_BASE_URL    默认 https://api.deepseek.com
LIVE_E2E_TIMEOUT_MS  默认 120000
```

本地执行：

```powershell
npm run test:e2e:retry-live
```

CI 中只允许在具备 secret 的受保护 job 中显式运行；fork PR、Dependabot PR 和普通单元测试 job 不运行该脚本。

## 10. 与单元测试的职责划分

live E2E 只保留一个恢复成功场景，避免增加费用。以下边界必须由 adapter 单元测试完成：

- 三次 503 后 retry exhausted。
- 400/401/403/404/422 不重试。
- context overflow 不做 transport retry。
- 2xx 后 SSE 中断不重试。
- 退避期间 abort。
- `onPayload`/`onResponse` 抛错不重试。
- `retry: false`。
- Retry-After 的日期格式、非法值和超长值。
- jitter 和指数退避的精确 delay。

职责边界：

```text
单元测试：证明所有分类和边界条件
live E2E：证明可重试失败之后，真实 provider streaming 链路仍可成功完成
```

## 11. 第二阶段 fault proxy 设计

如果需要覆盖完整 Agent Service HTTP 黑盒，新增一个只监听 loopback 的临时 proxy。测试启动顺序：

1. 启动 fault proxy，绑定 `127.0.0.1:0`。
2. proxy 保存真实 `DEEPSEEK_BASE_URL`，但日志中不保存 Authorization。
3. 启动 `deepseek-http-server.mjs`，把 `DEEPSEEK_BASE_URL` 指向 proxy。
4. HTTP 客户端创建 Profile/Session 并发送 Message。
5. proxy 对前两个 `/chat/completions` 请求返回 429/503，第三次转发真实 provider。
6. 客户端轮询 Run，读取 Transcript 和 Trace。
7. 断言只有一个 Run、一个用户消息、一个最终 assistant 消息，且 Run 成功。
8. 依次关闭 Agent Service、fault proxy，并删除临时 trace 目录。

proxy 必须原样流式转发真实 response body，不能先 `await response.text()`，否则无法覆盖生产 streaming 行为。

这一阶段建议在 adapter retry、diagnostics 和 Trace 事件稳定后再做，否则黑盒失败时难以区分是代理、Service、adapter 还是模型行为导致。

## 12. 实施顺序

1. 完成 retry 单元测试和 adapter 实现。
2. 新增 `scripts/deepseek-retry-live-e2e.mjs`，先只采集事件并手工运行。
3. 增加本 spec 第 7 节的机器断言。
4. 添加 npm script，但不加入默认测试套件。
5. 真实运行一次，保存脱敏 artifact 和一段简短执行记录。
6. 稳定后再决定是否实现 HTTP fault proxy 版本。

## 13. 验收标准

一次通过的 live E2E 必须同时给出以下证据：

- transport attempt 顺序为 `429 -> 503 -> real 200`。
- retry event 恰好 2 个，真实 provider 调用恰好 1 次。
- 对外 stream 恰好一个 `start` 和一个 `done`，没有 `error`。
- Agent Core 恰好一个逻辑 LLM call、没有 compact、没有 tool call。
- 最终回答包含本次 nonce，usage 大于 0。
- Run 成功结束，Session 被正常释放。
- artifact 不包含 API key 或 Authorization material。
- 脚本退出码为 0。

## 14. 2026-09-13 执行记录

- 命令：`npm run test:e2e:retry-live`
- 模型：`deepseek-v4-flash`
- Transport：`429 -> 503 -> real 200`
- Transport attempts：3
- 真实 provider 调用：1
- Retry delays：25ms、1ms
- Agent LLM calls：1
- Agent assistant turns：1
- Compact events：0
- Tool calls：0
- Stream terminal：一个 `done`，零个 `error`
- Token usage：111
- 最终回答：包含本次动态 `RETRY_OK_<timestamp>` nonce
- Artifact：`artifacts/chat-completions-retry-live-e2e.jsonl`
- 密钥扫描：通过
- 退出码：0
