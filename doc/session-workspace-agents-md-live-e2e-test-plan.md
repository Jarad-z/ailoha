# Session Workspace 与 `AGENTS.md` 真实模型 E2E 测试计划

状态：Validated（2026-09-13，LOCAL-01 + LIVE-01～LIVE-06 全部通过）

关联设计：[`session-workspace-agents-md-context-spec.md`](./session-workspace-agents-md-context-spec.md)

## 1. 测试目标

本测试计划使用真实 DeepSeek Chat Completions streaming 请求验证：

1. `Session.workspace.cwd` 确实决定 `AGENTS.md` 的读取位置。
2. `AGENTS.md` 正文确实进入发送给 Provider 的 system message。
3. 真实模型能执行 workspace 指令，而不只是本地 payload 看起来正确。
4. 同一个 Run 的多轮模型调用使用相同的 effective system prompt。
5. 下一个顶层 Run 会重新读取更新后的 `AGENTS.md`。
6. 不同 Session 的 workspace 指令严格隔离。
7. HTTP Agent Service 能把受控 `workspaceId` 解析为正确 cwd。
8. 文件读取失败发生在网络请求和 Context commit 之前。

Live E2E 是显式执行的 smoke test，不加入默认 `npm test`。它需要真实 API key，会访问外部
Provider，并产生少量费用。

## 2. 为什么同时验证 payload 和模型行为

只检查模型回答不够稳定：模型可能根据 user prompt 猜中测试 marker。只检查 payload 也不够：它
无法证明 Provider 实际收到并执行了请求。

每个真实调用案例至少验证三层证据：

| 层级 | 证据 | 作用 |
| --- | --- | --- |
| 请求投影 | `onPayload` 捕获的 `messages[0]` | 精确验证 system prompt 内容、顺序和重复次数 |
| Provider | HTTP 200、真实 request ID、stream terminal event、usage | 证明请求到达真实模型 |
| Agent 行为 | 最终回答、工具事件、Context/Trace 生命周期 | 证明完整 Agent 链路有效 |

模型回答只做语义断言，例如“包含本次随机 nonce 且不包含禁止 marker”；不依赖标点、Markdown 或
自然语言措辞完全一致。system payload 使用精确字符串断言。

## 3. 测试入口与环境

新增脚本：

```text
scripts/deepseek-workspace-agents-md-live-e2e.mjs
```

新增 npm script：

```json
{
  "test:e2e:workspace-live": "npm run build && node --env-file-if-exists=.env.local scripts/deepseek-workspace-agents-md-live-e2e.mjs"
}
```

环境变量沿用现有 live E2E：

```text
DEEPSEEK_API_KEY       必填
DEEPSEEK_MODEL         可选，默认 deepseek-v4-flash
DEEPSEEK_BASE_URL      可选，默认 https://api.deepseek.com
WORKSPACE_E2E_VERBOSE  可选，1 时输出安全的事件摘要
WORKSPACE_E2E_ARTIFACT_DIR 可选，覆盖测试产物目录
```

执行命令：

```powershell
npm run test:e2e:workspace-live
```

## 4. Harness 设计

### 4.1 临时 workspace

每次执行使用 `mkdtemp()` 在系统临时目录创建唯一根目录，不在仓库根目录创建真实
`AGENTS.md`：

```js
const e2eRoot = await mkdtemp(
	join(tmpdir(), "ailoha-agents-env-live-"),
);

const workspaceA = join(e2eRoot, "workspace-a");
const workspaceB = join(e2eRoot, "workspace-b");
await mkdir(workspaceA);
await mkdir(workspaceB);
```

测试结束后只能删除 `mkdtemp()` 返回的精确目录。清理前验证：

- `dirname(e2eRoot) === resolve(tmpdir())`；
- `basename(e2eRoot).startsWith("ailoha-agents-env-live-")`；
- 不接受空字符串、workspace 根目录或仓库根目录作为删除目标。

### 4.2 随机 marker

每个案例生成不会包含秘密的 nonce：

```js
const nonce = randomUUID().replaceAll("-", "").slice(0, 16);
const marker = `AGENTS_MD_${nonce}`;
```

marker 必须同时写进 `AGENTS.md` 和断言，不能只写进 user prompt。这样最终回答出现 marker 才能
证明模型读取到了 system instruction。

### 4.3 Provider 证明

每个真实请求记录以下安全字段：

```ts
interface ProviderEvidence {
	readonly modelCall: number;
	readonly status: number;
	readonly requestId?: string;
	readonly contentType?: string;
	readonly terminalEvent: "done" | "error";
	readonly stopReason?: string;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
}
```

不得记录：

- API key；
- Authorization header；
- 完整 request headers；
- 环境变量快照；
- 非测试生成的 workspace 文件正文。

### 4.4 请求捕获

ModelRunner 复用现有 Adapter，并在 `onPayload` 中保存结构化副本：

```js
const payloads = [];

async function run(context, { signal }) {
	return await adapter.complete(
		{
			systemPrompt: context.systemPrompt,
			messages: [...context.messages],
			tools: [...context.tools],
		},
		{
			signal,
			onPayload(payload) {
				payloads.push(structuredClone(payload));
			},
			onResponse(response) {
				recordSafeResponseMetadata(response);
			},
		},
	);
}
```

测试生成的 `AGENTS.md` 只包含 marker 和无敏感信息的控制指令，因此 artifact 可以保存本次测试的
system message。生产 workspace 的 debug trace 不适用这个例外。

## 5. 案例总览

| ID | 场景 | 真实 Provider calls | 必须级别 |
| --- | --- | ---: | --- |
| LIVE-01 | 基础 `AGENTS.md` 注入并执行 | 1 | 必须 |
| LIVE-02 | 同 Session 跨 Run 热更新 | 2 | 必须 |
| LIVE-03 | 工具调用前后 system prompt 稳定 | 2 | 必须 |
| LIVE-04 | 两个 Session workspace 隔离 | 2 | 必须 |
| LIVE-05 | HTTP Service 的 `workspaceId` 接线 | 1 | Service 实现后必须 |
| LIVE-06 | 手动 compact 读取 workspace 指令 | 2–3 | 可选慢测 |
| LOCAL-01 | 文件读取失败时零 Provider 调用 | 0 | 必须，但不是 live |

默认 live 套件预计产生 7–8 次模型调用。为控制费用，可以用环境变量只执行一个 case；CI
nightly 才执行完整矩阵。

## 6. LIVE-01：基础注入并执行

### 6.1 准备

静态 system prompt：

```text
You are running a live workspace-instruction E2E test. Follow exact marker instructions. Do not call tools and do not add unrelated text.
```

`<workspaceA>/AGENTS.md`：

```text
When the user sends WORKSPACE_INSTRUCTION_PROBE, include exactly this marker once in the answer: <marker>.
Do not mention any other AGENTS_MD_ marker.
```

User prompt 不包含 marker：

```text
WORKSPACE_INSTRUCTION_PROBE
```

### 6.2 执行

```js
const session = await Session.create({
	model,
	workspace: { cwd: workspaceA },
	createModelRunner: () => recordingRunner,
	contextManagerOptions: {
		systemPrompts: [baseSystemPrompt],
	},
});

const result = await session.agent.prompt(
	"WORKSPACE_INSTRUCTION_PROBE",
);
```

### 6.3 断言

请求断言：

1. 只有一次 Provider call。
2. `payload.messages[0].role === "system"`。
3. system content 先出现静态 prompt，再出现 workspace bridge，再出现 marker 指令。
4. marker 在 system content 中只出现一次。
5. 除首个 system message 外，其他 messages 都不包含 marker。
6. payload 没有把 cwd 字符串发送给 Provider。

真实调用断言：

1. HTTP status 是 200。
2. stream 以 `done` 结束。
3. stop reason 是正常完成状态。
4. usage 的 input/output/total tokens 大于 0。
5. 最终 assistant text 包含 marker，且只出现一次。

## 7. LIVE-02：同 Session 跨 Run 热更新

### 7.1 第一轮

写入：

```text
When the user sends RELOAD_PROBE_ONE, reply with marker <marker-v1>.
```

发送：

```text
RELOAD_PROBE_ONE
```

断言第一个 payload 的 system message 包含 `marker-v1`，最终回答包含 `marker-v1`。

### 7.2 第二轮

保持同一个 Session，原子替换文件内容：

```text
When the user sends RELOAD_PROBE_TWO, reply with marker <marker-v2>.
The active marker is <marker-v2>; do not repeat older markers from conversation history.
```

然后发起新的顶层调用：

```js
await session.agent.prompt("RELOAD_PROBE_TWO");
```

### 7.3 断言

1. 总共有两次 Provider call。
2. 第一次 `messages[0].content` 包含 v1，不包含 v2。
3. 第二次 `messages[0].content` 包含 v2，不包含 v1。
4. 第二次 payload 的历史 assistant message可以包含 v1，但 system message 不能残留 v1。
5. 第二次回答包含 v2，不包含 v1。
6. `Session.workspace` 对象和 cwd 在两轮之间没有变化。
7. Context history 中不存在 workspace bridge 或完整 `AGENTS.md` 正文。

该案例明确验证“每个顶层 Run 读取一次”，不能用 Session 创建时永久缓存文件。

## 8. LIVE-03：工具调用前后 system prompt 稳定

### 8.1 准备

注册真实 Agent tool `calculator`。这里的“真实”表示工具由 Agent Core 实际查找、校验和执行；只有
计算本身是本地确定性逻辑。

静态 system prompt：

```text
For arithmetic requests, call calculator exactly once, wait for its result, then answer briefly.
```

`AGENTS.md`：

```text
After calculator succeeds, include marker <tool-marker> in the final answer.
```

User prompt：

```text
请调用 calculator 计算 (137 * 42) + 19，然后给出结果。
```

### 8.2 预期调用链

```text
LLM call 1
  -> assistant tool_call(calculator)
  -> Agent executes calculator
  -> toolResult(5773)
LLM call 2
  -> final assistant answer
```

### 8.3 断言

1. 恰好两次真实 Provider call。
2. 两个 payload 的首个 system message 字节完全相同。
3. 两次 `context.prepared`/`llm.call.started` 记录的 workspace instruction hash 相同。
4. 第二次 payload 包含第一次 assistant tool call 和对应 tool result。
5. `AGENTS.md` fragment 没有作为 user/tool message重复出现。
6. calculator 恰好请求一次并成功完成。
7. 最终回答包含 `5773` 和 `<tool-marker>`。
8. Trace 顺序为：

```text
context.prepared
llm.call.started
llm.call.finished(tool_calls)
tool.call.requested
tool.call.started
tool.call.finished(success)
llm.call.started
llm.call.finished(final)
agent.run.finished(success)
```

## 9. LIVE-04：两个 Session workspace 隔离

### 9.1 准备

```text
workspace-a/AGENTS.md -> marker-a
workspace-b/AGENTS.md -> marker-b
```

分别创建 `sessionA` 和 `sessionB`，然后并行发送同一个、不包含任何 marker 的 probe prompt。

### 9.2 断言

1. `sessionA.workspace.cwd !== sessionB.workspace.cwd`。
2. Session A 的 system message 包含 marker-a，不包含 marker-b。
3. Session B 的 system message 包含 marker-b，不包含 marker-a。
4. A 的最终回答包含 marker-a，不包含 marker-b。
5. B 的最终回答包含 marker-b，不包含 marker-a。
6. 两个 Run 的 trace `sessionId`、`runId` 和 context hash 不混用。
7. 两个 Session 可以并发完成，不使用全局 cwd 或全局文件缓存。

这个案例可以发现错误实现，例如在 `process.cwd()` 下统一读取文件，或把最近一次读取结果存进模块
级变量。

## 10. LIVE-05：HTTP Service `workspaceId` 接线

该案例在 Agent Service 支持 `workspaceId` 后启用，建议新增独立脚本：

```text
scripts/deepseek-workspace-agents-md-http-e2e.mjs
```

### 10.1 服务端 allowlist

```js
const workspaces = new Map([
	["workspace-a", workspaceA],
]);

const runtime = new AgentServiceRuntime({
	resolveSessionOptions(profile, context) {
		const cwd = workspaces.get(context.workspaceId);
		if (!cwd) throw new Error("Workspace is not allowlisted.");

		return {
			model,
			workspace: { cwd },
			createModelRunner: () => recordingRunner,
			contextManagerOptions: {
				systemPrompts: profile.systemPrompts,
			},
		};
	},
});
```

### 10.2 HTTP 流程

```text
POST /v1/agent-profiles
POST /v1/sessions { agentProfileId, workspaceId: "workspace-a" }
GET  /v1/sessions/{id}
GET  /v1/sessions/{id}/trace
POST /v1/sessions/{id}/messages
GET  /v1/runs/{runId}
GET  /v1/sessions/{id}/messages
```

### 10.3 断言

1. Session create 返回 201，ready Session 绑定正确 workspace。
2. HTTP 客户端不能提交任意 `cwd`；发送 `cwd` 字段应返回 400 或被 schema 拒绝。
3. 未知 `workspaceId` 创建失败，且零 Provider calls。
4. allowlisted `workspaceId` 能完成一次真实 streaming 调用。
5. 最终 transcript 中的回答包含 workspace marker。
6. Transcript 不包含 `AGENTS.md` 正文。
7. Trace 生命周期完整，`workspaceInstructionsLoaded === true`。
8. Service 返回物理 cwd 时，它与 resolver 结果一致；若部署选择隐藏 cwd，则只返回 workspaceId。

## 11. LIVE-06：手动 compact 重新读取文件

这是费用较高的慢测，默认不执行。

### 11.1 流程

1. 创建 Session，`AGENTS.md` 使用 marker-v1。
2. 完成一个真实 prompt，建立可压缩历史。
3. 把文件替换为 marker-v2。
4. 调用 `session.agent.compact()`。
5. SummaryRunner 通过真实 Provider 生成 checkpoint。
6. 再发起一个顶层 prompt。

### 11.2 断言

1. 手动 compact 的 summary payload system message 包含 marker-v2，不包含 marker-v1。
2. summary 请求没有 tools，且 `toolChoice === "none"`。
3. compact 返回 `changed === true`，并产生合法 checkpoint。
4. checkpoint message 中不需要复制完整 `AGENTS.md` 正文。
5. compact 后的业务调用重新读取当前文件并包含 marker-v2。
6. 最终回答遵循 marker-v2。
7. summary call 不增加业务 `assistantTurnCount`。

如果 history 太短导致没有可压缩消息，测试应使用确定性的长用户消息填充 Context，而不是通过大量
真实 Provider calls 制造历史。

## 12. LOCAL-01：读取失败时零 Provider 调用

该案例和 live cases 放在同一脚本中执行，但不访问 Provider。

至少覆盖两个子场景：

- `AGENTS.md` 大于 64 KiB；
- `AGENTS.md` 是符号链接或非法 UTF-8 文件。

ModelRunner 使用计数器；如果被调用立即抛出测试错误：

```js
let providerCalls = 0;

const rejectingRunner = {
	async run() {
		providerCalls++;
		throw new Error("Provider must not be called");
	},
};
```

断言：

1. `agent.prompt()` reject 为正确的 `WorkspaceContextError.code`。
2. `providerCalls === 0`。
3. `contextManager.snapshot().messages` 与调用前完全相同。
4. Agent 回到 `idle`。
5. 第二次修复文件后可以正常发起新 Run。

## 13. Artifact 设计

输出：

```text
artifacts/workspace-agents-md-live-e2e.jsonl
artifacts/workspace-agents-md-live-e2e-summary.json
```

JSONL 建议事件：

```ts
type WorkspaceLiveRecordType =
	| "case.started"
	| "workspace.file.written"
	| "model.request"
	| "model.response"
	| "model.stream.event"
	| "agent.trace"
	| "case.assertions"
	| "case.finished";
```

`workspace.file.written` 只记录：

```json
{
  "workspace": "workspace-a",
  "fileName": "AGENTS.md",
  "byteLength": 123,
  "sha256": "sha256:..."
}
```

不记录临时目录之外的文件正文。Summary 文件包含每个案例的状态、Provider call 数、模型 ID、
request IDs、token usage、持续时间和 artifact 路径。

## 14. 防止假阳性

测试必须满足：

1. user prompt 中不出现预期 marker。
2. marker 每次运行随机生成，不能硬编码到模型可能记住的测试语料。
3. payload 断言和回答断言同时通过。
4. 至少取得 HTTP 200 和成功 stream terminal event。
5. 没有 Provider call 的场景不能标为 live success。
6. 回答只检查当前 marker，不用固定自然语言全文匹配。
7. 每个案例结束后检查没有未消费的 tool call 或缺失 tool result。
8. 测试失败时也必须写出已经采集的安全 artifact，方便诊断。

## 15. 超时、重试与费用控制

- 单次 Provider call timeout：90 秒。
- 每个案例总 timeout：180 秒。
- 默认不注入重试故障；Adapter 使用生产 retry 策略或最多 2 次 attempt。
- Artifact 区分 Agent LLM call 与 transport retry attempt。
- 完整必须案例最多允许 10 次 Agent LLM calls，超过立即失败。
- 禁止为了等待真实 429/503 而循环请求。
- LIVE-06 默认由 `WORKSPACE_E2E_INCLUDE_COMPACTION=1` 显式启用。

## 16. 通过标准

一次完整执行通过必须满足：

1. LIVE-01 至 LIVE-04 全部成功。
2. LOCAL-01 成功且没有真实网络调用。
3. 实现 Agent Service workspace 接线后，LIVE-05 成功。
4. 每个 live case 都有真实 HTTP 200、成功 stream terminal event 和正数 usage。
5. 没有 artifact 包含 API key 或 Authorization header。
6. 临时 workspace 已安全清理。
7. 所有 Session 已 dispose，Agent 状态没有残留 running/compacting。

LIVE-06 属于慢测，不阻塞默认 live smoke；发布 Context compaction 与 workspace 集成版本前必须至少
人工运行一次。
