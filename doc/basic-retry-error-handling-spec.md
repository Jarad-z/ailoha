# 基础重试与异常处理 Spec

状态：Implemented v0.1（MVP）

## 1. 背景与结论

Ailoha 当前已经具备一部分异常处理基础：

- `chat-completions-adapter` 关闭了 OpenAI SDK 的自动重试（`maxRetries: 0`），失败会被转换为 `AssistantMessage.stopReason = "error"`。
- `agent-core` 已区分输入错误、状态错误、取消、模型错误和上下文溢出。
- `agent-service` 已有统一的 `ServiceError` 结构和 `retryable` 字段。
- 写接口要求 `Idempotency-Key`，可以阻止客户端重复提交同一个操作。

当前缺口是：系统还没有统一、可配置、可测试的重试策略，也没有完整区分“暂时性错误”和“确定性错误”。此外，Core 当前可能在任意 LLM 错误后触发 compact，网络错误和上下文溢出的恢复路径没有完全分离。

第一期建议只实现 **LLM 请求建立阶段的自动重试**，并同时收紧 Core 的 compact 恢复条件。工具调用默认不自动重试，Service 层不重复一整个 Run。

```text
LLM 暂时性传输错误  -> adapter 内短重试 -> 成功或返回最终失败
上下文窗口溢出      -> agent-core compact 一次 -> 再调用一次 LLM
工具执行失败        -> 生成 isError tool result -> 交给模型决定下一步
取消/输入/配置错误   -> 立即失败，不重试
```

## 2. 目标

MVP 必须做到：

- 对连接失败、请求超时、限流和部分 5xx 错误执行有限次数的指数退避重试。
- 明确哪些错误不得重试。
- 取消信号可以中断请求和退避等待。
- 不在已经开始消费流式响应后自动重试，避免重复输出和重复 tool call。
- 不因为普通网络错误触发 context compact。
- 最终失败继续沿用现有 `AssistantMessage`、`ModelError` 和 `ServiceError` 传播链路。
- Trace/diagnostics 至少能看出尝试次数、最后一次错误和是否已耗尽重试。
- 测试不依赖真实等待、真实网络或随机数。

## 3. 非目标

MVP 不实现：

- 自动重试整个 Agent Run。
- 默认重试工具调用。
- 跨进程重试状态持久化。
- 熔断、跨 provider fallback、请求 hedging 或全局限流器。
- 无限重试或后台任务式重试。
- 修改公开 HTTP API 以增加“重跑 Run”接口。

## 4. 设计原则

### 4.1 在最接近失败源的位置重试

网络和 provider 错误由 `chat-completions-adapter` 分类并重试。`agent-core` 不解析 HTTP 状态码，`agent-service` 也不重新执行整个 Agent Run。

这样可以避免一次短暂的 503 导致以下内容被整体重复：

- 再次追加用户消息。
- 再次消费 turn budget。
- 再次执行已经成功的工具。
- 再次创建 Run 或 Operation。

### 4.2 重试与恢复不是同一件事

- **Retry**：请求尚未产生可提交结果，因暂时性基础设施错误再次发送相同 LLM 请求。
- **Recovery**：上下文过长时改变 context（compact）后发送一个新请求。
- **Re-plan**：工具失败作为 tool result 返回给模型，由模型决定是否换参数、换工具或停止。

三者必须有独立条件和计数，不能共用一个“失败就再来一次”的分支。

### 4.3 默认至多执行一次有副作用的动作

LLM 请求不会直接修改 Ailoha 的业务状态，因此可以在严格边界内重试。工具可能发送消息、写文件或创建任务，无法仅凭异常判断服务端是否已经执行成功，所以默认不自动重试。

## 5. 错误分类

| 类别 | 示例 | 自动重试 | 最终处理 |
| --- | --- | --- | --- |
| 取消 | `AbortError`、调用方 signal aborted | 否 | Run 标记为 `aborted` |
| 配置/编程错误 | 空 API key、非法 base URL、hook 抛错 | 否 | 立即失败并保留安全错误信息 |
| 请求错误 | HTTP 400、401、403、404、422 | 否 | 返回模型失败；鉴权信息不得泄漏 |
| 上下文溢出 | provider code 映射为 `CONTEXT_WINDOW_EXCEEDED` | adapter 不重试 | Core compact 一次，成功改变 context 后再调用一次 |
| 暂时性传输错误 | DNS、连接重置、连接超时、请求超时 | 是 | adapter 内退避重试 |
| 暂时性 HTTP 错误 | 408、409、429、500、502、503、504 | 是 | adapter 内退避重试 |
| 协议/响应错误 | 非法 SSE、非法 JSON、缺少 finish reason | 否 | 保留已收到的部分内容并失败 |
| 工具查找/参数错误 | tool 不存在、JSON Schema 校验失败 | 否 | 返回 `isError: true` tool result |
| 工具执行异常 | tool 抛出非取消异常 | 默认否 | 返回 `isError: true` tool result |
| Service 状态冲突 | Agent 已运行、消息阶段不允许 | 否 | 409，调用方修正操作 |
| Service 容量/不可用 | capacity、runtime unavailable | 当前不在本期内部重试 | 429/503，由上层稍后处理 |

补充规则：

- 不应只根据错误 message 文本判断是否可重试。
- HTTP 状态码优先于 SDK 错误名称；无状态码时才使用明确的连接/超时错误类型或 code。
- `AbortError` 的优先级最高，即使底层同时报告连接错误也不得重试。
- `ChatCompletionsProtocolError`、`UnsupportedContentError` 和 `ChatCompletionsConfigError` 永不重试。
- 已经收到 2xx 并进入流式消费后发生的任何错误，MVP 均不重试。

## 6. 重试策略

### 6.1 默认值

```ts
export interface RetryPolicy {
	readonly maxAttempts: number;       // 包含第一次请求，默认 3
	readonly baseDelayMs: number;       // 默认 250
	readonly maxDelayMs: number;        // 默认 2_000
	readonly respectRetryAfter: boolean;// 默认 true
}

export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
	maxAttempts: 3,
	baseDelayMs: 250,
	maxDelayMs: 2_000,
	respectRetryAfter: true,
});
```

构造参数增加：

```ts
export interface ChatCompletionsAdapterOptions {
	// existing fields...
	readonly retry?: false | Partial<RetryPolicy>;
}

export interface ChatCompletionsRunOptions {
	// existing fields...
	readonly onRetry?: (event: RetryEvent) => void | Promise<void>;
}
```

- `retry: false` 表示只尝试一次。
- 未配置时使用默认策略。
- `maxAttempts` 取值为 1 到 5，防止误配置为无限重试。
- `baseDelayMs`、`maxDelayMs` 必须为有限非负数，且 `baseDelayMs <= maxDelayMs`。
- OpenAI SDK 继续保持 `maxRetries: 0`，只能由 Ailoha 的一层策略控制重试，避免次数相乘。

### 6.2 退避算法

第 `attempt` 次失败后，先计算：

```text
cap = min(maxDelayMs, baseDelayMs * 2^(attempt - 1))
delay = random(0, cap)  // full jitter
```

若响应包含合法的 `Retry-After` 或 `retry-after-ms`：

- `respectRetryAfter = true` 时优先使用 provider 给出的等待时间。
- provider 等待时间最大接受 30 秒；更大的值视为不适合一次同步 Run，直接返回最终失败。
- 等待必须可被调用方的 `AbortSignal` 中断。

为保证测试确定性，内部重试执行器允许注入：

```ts
interface RetryRuntime {
	readonly sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
	readonly random: () => number;
}
```

该接口只用于包内测试，不需要作为第一期公开 API。

## 7. 流式响应的安全边界

重试仅包裹以下操作：

```ts
client.chat.completions.create(payload, { signal, maxRetries: 0 }).withResponse()
```

一旦获得 2xx response 并调用 `accumulator.start()`，本次请求视为已经提交给下游：

- 后续 SSE 解帧失败不重试。
- 中途断线不重试。
- 收到部分 text/reasoning/tool call 后不重试。
- `finish_reason` 或 tool arguments 非法不重试。

原因是当前 `AssistantEventStream` 可能已经向消费者发出事件。使用同一个 stream 重新生成会造成文本重复、tool call ID 变化和不可预测的计费。

`onPayload` 在重试循环外只调用一次，得到最终 payload 后所有 attempt 复用该不可变快照。hook 自身抛错不重试。

`onResponse` 仍只针对成功获得的 2xx response 调用一次。失败 attempt 的可观测信息通过 `onRetry` 和 diagnostics 提供，不复用 `onResponse`。

## 8. 执行流程

```text
buildPayload
    |
onPayload（一次；失败立即结束）
    |
attempt 1: create request
    |-- success 2xx ----------------------> accumulator.start -> consume stream
    |                                           |-- success -> done
    |                                           `-- failure -> error，不重试
    |
    `-- failure
          |-- abort / permanent / exhausted --> accumulator.fail
          `-- transient ----------------------> onRetry -> abortable sleep
                                                    `-> attempt 2/3
```

伪代码：

```ts
const replacement = await options.onPayload?.(initialPayload);
const payload = structuredClone(replacement ?? initialPayload);

for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt++) {
	try {
		signal.throwIfAborted();
		const result = await createRequest(payload, signal);
		await options.onResponse?.(toResponseInfo(result.response));
		accumulator.start();
		await consume(result.data);
		accumulator.finish();
		return;
	} catch (cause) {
		if (accumulator.state !== "created") throw cause;
		const decision = classifyRetry(cause, signal, attempt, retryPolicy);
		if (!decision.retry) throw cause;
		await options.onRetry?.(decision.event);
		await abortableSleep(decision.delayMs, signal);
	}
}
```

实际实现需要把 `onResponse` 的异常标记为 hook error，避免被误判为 transport error。也可以把 `onResponse` 放在重试循环成功返回之后执行；但必须确保在 `accumulator.start()` 前执行，并保持当前 callback 顺序。

## 9. Core 异常恢复调整

当前 `Agent.#runLlmWithCompactRecovery()` 会在多数 LLM 错误后调用：

```ts
compact({ reason: "llm_error", error })
```

第一期应调整为仅在 `isContextWindowExceededError(error)` 为真时触发 compact recovery：

```ts
try {
	return await this.#runLlmAttempt(context, activeRun);
} catch (cause) {
	if (signal.aborted) signal.throwIfAborted();
	const error = toError(cause);
	if (!isContextWindowExceededError(error)) throw error;

	const result = await this.#compactWithTrace("llm_error", context, activeRun, error);
	if (!result.changed) throw error;
	return await this.#runLlmAttempt(context, activeRun);
}
```

这次 compact 后的第二次 LLM 调用仍拥有 adapter 自己的最多 3 个 transport attempts，但 Core 不允许再次 compact，避免恢复循环。

计数语义必须保持：

- adapter 内 transport attempt 不增加 Agent `turnCount`。
- compact 后重新调用 `#runLlmAttempt` 增加一次 `turnCount`，因为 context 已改变，这是新的模型 turn。
- tool error 不额外增加 turn；模型看到 tool error 后继续 ReAct 时才增加下一 turn。

## 10. Tool 异常处理

MVP 保持现有行为：

- tool 不存在或参数校验失败：生成 `isError: true` 的 tool result。
- tool 抛出普通异常：记录 Trace，生成 `isError: true` 的 tool result。
- tool 抛出 `AbortError` 或 Run signal 已取消：终止 Run，不把它降级成普通 tool error。

第一期禁止在 `Agent.#executeToolCall()` 外层增加通用 retry。

未来如确需工具重试，必须由工具显式声明能力，例如：

```ts
interface AgentTool {
	readonly retry?: {
		readonly safe: true;
		readonly maxAttempts: number;
	};
}
```

只有满足以下条件之一才能声明 `safe: true`：

- 工具是只读操作。
- 工具把稳定的 `toolCall.id` 作为下游 idempotency key。
- 工具自身可以证明重复请求不会产生额外副作用。

这部分不进入 MVP。

## 11. 错误传播与安全信息

最终 transport attempts 全部失败后，adapter 继续产出一个终态错误消息：

```ts
assistant.stopReason = "error";
assistant.errorMessage = safeMessage;
assistant.diagnostics = [{
	type: "chat_completions_failure",
	timestamp: Date.now(),
	error: { name, message, code },
	details: {
		status,
		requestId,
		attempts,
		retryExhausted,
		retryable: false,
	},
}];
```

这里 `retryable: false` 表示 adapter 已经完成本次 Run 允许的内部重试，不建议 Service 再自动重复整个 Run。

安全要求：

- API key、Authorization、Cookie 和完整 headers 不得进入 error、diagnostics、Trace 或回调事件。
- 面向 HTTP 客户端的 500 错误保持通用文案；provider 原始错误只进入经过脱敏的内部 diagnostics/Trace。
- `cause` 可以在进程内保留，但不得直接 JSON 序列化到 HTTP 响应。
- 错误分类失败时采用 fail closed：默认不重试。

## 12. 可观测性

建议新增只读回调结构：

```ts
export interface RetryEvent {
	readonly attempt: number;       // 刚失败的 attempt，从 1 开始
	readonly nextAttempt: number;
	readonly delayMs: number;
	readonly reason: "timeout" | "connection" | "http_status";
	readonly status?: number;
	readonly requestId?: string;
}
```

要求：

- 每次真正准备重试时记录一次事件。
- 不记录请求 body、消息正文或完整 headers。
- 最终 diagnostics 记录总 attempts；成功时可由 `onRetry`/Trace 得知此前发生过重试。
- Trace 后续可以增加 `llm.retry_scheduled`，但不应阻塞 MVP；第一期可先通过 adapter callback 接入现有 Trace。

## 13. Service 层语义

Service 层保留统一错误映射，但需要遵守：

- HTTP handler 不自动重试 Runtime 方法。
- `Idempotency-Key` 只解决客户端重复提交，不替代 adapter 的 transport retry。
- 一个已经失败的 Run 不由 Service 静默重跑。
- `RunInfo.error.retryable` 对 adapter 已耗尽的模型错误应为 `false`，避免客户端重复提交同一条用户消息。

当前 `#executeIdempotent()` 会缓存 rejected promise，且在 TTL 内使用相同 key 会得到同一失败。因此在没有定义“失败前是否已提交”的持久化状态前，不应告诉客户端对同一个失败 Operation 无限重试。

后续若要让 admission 阶段的 429/503 支持同 key 重试，应单独设计：只有确认 action 尚未产生任何状态变更时，才从 idempotency map 删除失败记录。该行为不进入本期。

## 14. 测试计划

### 14.1 Adapter 单元测试

至少覆盖：

1. 第一次连接错误，第二次成功；只产生一套 stream 事件。
2. 连续三次 503；总请求数为 3，最终 `stopReason = "error"`。
3. 429 带合法 `Retry-After`；使用指定 delay。
4. 429 带超过 30 秒的 `Retry-After`；不等待并直接失败。
5. 400、401、403、404、422 各只请求一次。
6. context length 400 只请求一次，并保留 `CONTEXT_WINDOW_EXCEEDED` code。
7. 2xx 后 SSE 在首 chunk 前断开；不重试。
8. 已收到部分 text 后断开；保留部分 text 且不重试。
9. 退避等待中 abort；不再发下一次请求，终态为 `aborted`。
10. `onPayload` 和 `onResponse` 抛错；不重试。
11. API key 和 Bearer token 在每种最终错误中均已脱敏。
12. `retry: false` 和 `maxAttempts: 1` 均只请求一次。

### 14.2 Core 单元测试

至少覆盖：

1. `ContextWindowExceededError` 会 compact，context 改变后只恢复一次。
2. 普通 `ModelError` 不调用 compact。
3. `AbortError` 不调用 compact。
4. compact 未改变 context 时传播原始 overflow error。
5. recovery 后第二次失败不再 compact。
6. tool 普通异常仍转换为 `isError` result，不自动重试。
7. tool abort 仍取消整个 Run。

### 14.3 Service 单元测试

至少覆盖：

1. 最终模型失败产生 `run.failed`，不会创建第二个 Run。
2. 最终模型失败的公开 `retryable` 值符合本 spec。
3. 同一个 `Idempotency-Key` 不会重复追加消息或执行工具。

## 15. 验收标准

MVP 完成的判定标准：

- 所有重试次数都有硬上限。
- 只有第 5 节列出的暂时性 LLM 错误会自动重试。
- 任意时点取消都能阻止后续 attempt。
- 已开始的流式响应绝不自动重试。
- 普通网络错误不会触发 compact。
- 工具调用不会被框架自动重复执行。
- 同一次 LLM 调用对外最多发出一组 `start ... done/error` 事件。
- `npm run check` 和全部 workspace tests 通过。

## 16. 推荐实施顺序

### PR 1：先完成 adapter 内部重试

从这里入手，改动面最小、收益最高：

1. 新建 `packages/chat-completions-adapter/src/retry.ts`。
2. 实现 `normalizeRetryPolicy`、`classifyRetry`、`retryAfterMs` 和 `abortableSleep`。
3. 在 `types.ts` 增加 `RetryPolicy`、`RetryEvent` 和 adapter options。
4. 在 `adapter.ts` 中只包裹 `create(...).withResponse()`，保留 SDK `maxRetries: 0`。
5. 在 `adapter.test.ts` 用假的 `fetch`、`sleep` 和 `random` 补齐第 14.1 节测试。

### PR 2：修正 Core 的恢复条件

1. 修改 `packages/agent-core/src/agent.ts` 的 `#runLlmWithCompactRecovery()`。
2. 只有 `ContextWindowExceededError` 才进入 `llm_error` compact。
3. 更新当前“任意模型错误可 compact”的测试，使网络/普通模型失败直接传播。

### PR 3：统一最终错误语义与观测

1. diagnostics 增加 `attempts` 和 `retryExhausted`。
2. 接入 Trace 或最小 `onRetry` 记录。
3. 调整 `agent-service/src/errors.ts`，避免把 adapter 已耗尽的 Run 错误继续标记成可安全自动重试。
4. 增加 Service E2E 断言。

不建议第一步就做工具重试、Run 重跑或 idempotency cache 重构；这些功能需要先定义副作用提交点和持久化语义。
