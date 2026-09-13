# Agent Core Minimal Spec

状态：Draft v0.3

## 1. 目标

实现一个最小、可运行、可继续扩展的 Agent Core。

MVP 只负责：

- 由 Context Manager 保存 system prompts、消息历史并生成运行上下文。
- 由 Agent 保存运行状态并驱动执行流程。
- 接收普通 prompt、steer message 和 follow-up message。
- 通过独立的 Tool Manager 实例化本次运行需要的 tools。
- 执行外层 follow-up loop 和内层 ReAct loop。
- 在两个固定时机执行 context compact。
- 暴露运行状态、取消能力和等待运行结束的能力。

MVP 暂不实现：

- 通用 hook 系统。
- spec node 调度。
- 持久化和断点恢复。
- 不可变的完整 transcript 或审计日志。
- 多 Agent 协作。
- tool 并发策略。
- steer/follow-up 的批处理模式配置。
- 自动重试网络错误、限流错误或鉴权错误。

## 2. 核心对象边界

最小系统有三个核心对象：

```text
Agent
  - 持有运行状态
  - 持有两个消息队列
  - 驱动双循环
  - 调用 LLM
  - 执行已实例化的 tool

ContextManager
  - 持有 system prompts
  - 持有当前上下文历史
  - 组装 run-local context
  - 提交新消息
  - 执行 context compact

ToolManager
  - 注册 tool factory
  - 根据 ToolRequest 实例化 tools
  - 不持有 Agent 对话状态
  - 不驱动 Agent loop
```

`ContextManager` 和 `ToolManager` 都是注入给 `Agent` 的外部依赖。

所有权规则：

```text
运行控制、状态、队列       → Agent
system prompts、messages、compact → ContextManager
tool 注册和实例化          → ToolManager
```

Agent 不保存 system prompt 的副本，也不保存 context history 的副本。否则 ContextManager 就不是 context 的唯一事实来源。

## 3. Agent 公共接口

```ts
type AgentStatus = "idle" | "running";

type AgentInputMessage = Extract<AgentMessage, { role: "user" }>;

interface AgentOptions {
	model: Model;
	modelRunner: ModelRunner;
	contextManager: ContextManager;
	toolManager: ToolManager;
	toolRequests?: ToolRequest[];
}

class Agent {
	readonly state: AgentState;

	prompt(
		input: string | AgentInputMessage | AgentInputMessage[],
	): Promise<RunResult>;
	steer(message: AgentInputMessage): void;
	followUp(message: AgentInputMessage): void;
	abort(): void;
	waitForIdle(): Promise<void>;
}
```

`AgentInputMessage` 是外部调用方可以提交的消息类型，只允许 `role: "user"`。完整的 `AgentMessage` 还可以包含 assistant 和 tool result，但这些消息只能由 Agent Core 内部生成并通过 Context Manager 提交。

公开入口必须执行运行时校验，不能只依赖 TypeScript 类型：

- 字符串 prompt 规范化为一个 `AgentInputMessage`。
- `prompt()` 收到非法消息时，在创建 active run 和实例化 tools 之前 reject。
- `steer()` 或 `followUp()` 收到非法消息时不入队，并同步抛出输入校验错误。
- 外部调用方不能提交 system、assistant 或 tool-result message；system prompts 只能由 Context Manager 管理。

运行约束：

- `prompt()` 只能在 `idle` 状态调用。
- `prompt()` 开始后，状态同步切换为 `running`。
- `steer()` 和 `followUp()` 除了检查 `running`，还必须按 active run 的消息准入阶段决定是否接受消息。
- 运行成功、失败或被取消后，状态都必须回到 `idle`。
- 同一个 Agent 同一时间最多有一个 active run。

## 4. Agent 状态

```ts
interface AgentState {
	model: Model;
	status: AgentStatus;
	activeAssistantMessage?: AssistantMessage;
	lastError?: Error;
}
```

派生属性：

```ts
const isRunning = state.status === "running";
```

`status` 是运行状态的唯一事实来源。不要同时维护可独立写入的 `status`、`isRunning`、`isStreaming` 三份状态。

`status` 只描述整个 run 是否仍然存活。为了避免异步函数返回时出现“消息被接受，但循环已经结束”的竞态，active run 还必须维护一个私有的消息准入阶段：

```ts
type RunPhase = "react" | "follow_up" | "closing";

interface ActiveRun {
	readonly controller: AbortController;
	readonly signal: AbortSignal;
	phase: RunPhase;
}
```

准入规则：

```text
react       → 接受 steer，也接受 follow-up
follow_up   → 拒绝 steer，接受 follow-up
closing     → 拒绝 steer，也拒绝 follow-up
```

`RunPhase` 不是第二份运行状态，不暴露在 `AgentState` 中：

- `status === "idle"` 时不存在 active run，也不存在 phase。
- `status === "running"` 时 active run 必须具有一个明确的 phase。
- `steer()` 只在 `status === "running" && phase === "react"` 时接受消息。
- `followUp()` 只在 `status === "running" && phase !== "closing"` 时接受消息。
- 在任何可能把控制权交还事件循环的边界之前，必须同步设置好正确的 phase。

`running` 表示整个 Agent run 尚未结束，包括：

- LLM 正在生成。
- tool 正在执行。
- compact 正在执行。
- 正在消费 steer 或 follow-up。

它不等同于“LLM 正在 streaming”。

需要读取 system prompts 或当前 context history 的调用方，通过 `ContextManager.snapshot()` 获取只读快照，不通过 `Agent.state` 获取。

## 5. 两个消息队列

```ts
class MessageQueue {
	enqueue(message: AgentInputMessage): void;
	drain(): AgentInputMessage[];
	clear(): void;
	get size(): number;
}
```

Agent 内部持有：

```ts
private readonly steerQueue: MessageQueue;
private readonly followUpQueue: MessageQueue;
```

MVP 规则：

- 两个队列都是 FIFO。
- `drain()` 一次取走当前全部消息。
- 新消息必须通过 `steer()` 或 `followUp()` 入队，不能直接修改队列。
- 队列消息只有在被注入 context 时，才写入当前 context history。

### 5.1 Steer Queue

Steer 用于改变当前正在执行的任务。

检查时机：每次内层 ReAct 迭代中，assistant message 以及该消息触发的全部 tool results 写入之后。

如果同一轮同时存在 tool calls 和 steer messages，消息顺序必须是：

```text
assistant(tool calls)
tool result 1
tool result 2
...
steer message 1
steer message 2
...
下一次 LLM 调用
```

这样可以保证 tool call 与 tool result 的关联结构完整。

### 5.2 Follow-up Queue

Follow-up 用于在当前任务自然结束后启动下一段任务。

检查时机：内层 ReAct loop 已经满足退出条件之后。

- 队列非空：把 follow-up messages 注入 context，重新进入内层 ReAct loop。
- 队列为空：结束整个 Agent run。

## 6. Tool Manager

### 6.1 Tool 定义

```ts
interface AgentTool {
	name: string;
	description: string;
	parameters: JsonSchema;
	execute(
		call: ToolCall,
		context: ToolExecutionContext,
	): Promise<ToolResult>;
}

interface ToolRequest {
	name: string;
	options?: Record<string, unknown>;
}

type ToolFactory = (
	request: ToolRequest,
	context: ToolInitContext,
) => AgentTool | Promise<AgentTool>;
```

### 6.2 Tool Manager 接口

```ts
class ToolManager {
	register(name: string, factory: ToolFactory): void;

	instantiate(
		requests: ToolRequest[],
		context: ToolInitContext,
	): Promise<AgentTool[]>;
}
```

实例化规则：

- tools 在一次顶层 `prompt()` 开始时实例化一次。
- 同一 active run 的所有 ReAct 和 follow-up 循环复用这些实例。
- 下一次独立 `prompt()` 重新实例化。
- Tool Manager 遇到未注册 tool name 时直接报错，Agent loop 不启动。
- 实例化结果按 tool name 建立只读索引。
- MVP 中 tool calls 按 assistant message 中的顺序串行执行。
- Tool Manager 等待异步 factory 时，每个 await 都必须在 finally 中检查 `ToolInitContext` 的 signal；取消后不得继续实例化剩余 tools。

Agent 执行 tool call 时负责：

1. 按名称查找 tool。
2. 校验 tool arguments。
3. 在调用 `tool.execute()` 前检查 abort signal。
4. 调用 `tool.execute()`。
5. 在 `tool.execute()` 结束后再次检查 abort signal。
6. 把非取消的成功或失败统一转换为 `ToolResultMessage`。
7. 如果发生取消，为当前以及本轮剩余的 tool calls 生成 cancelled/skipped `ToolResultMessage`。
8. 请求 Context Manager 提交结果。

Tool Manager 不负责消息写入和循环控制。

## 7. Context Manager

Context Manager 是所有 LLM 上下文数据的唯一所有者。

本文中的 context history 指当前用于后续模型调用的消息历史，不是不可变的完整 transcript：

- `ContextManager.snapshot()` 返回当前 system prompts 和当前 context history。
- compact 可以用摘要等新消息替换旧的 context history；compact 成功后，`snapshot()` 返回替换后的历史。
- 被 compact 替换的原始消息不再由 Agent Core 保存，也不能通过 `snapshot()` 恢复。
- 如果调用方需要完整 transcript、审计或事件回放，必须在 Agent Core 之外通过事件记录等方式实现；这不属于 MVP。

### 7.1 公共接口

```ts
interface BeginRunContextRequest {
	promptMessages: AgentInputMessage[];
	tools: readonly AgentTool[];
	signal: AbortSignal;
}

type SystemPrompt = string;

interface ContextSnapshot {
	systemPrompts: readonly SystemPrompt[];
	messages: readonly AgentMessage[];
}

interface ContextManager {
	beginRun(request: BeginRunContextRequest): Promise<AgentContext>;

	append(
		context: AgentContext,
		messages: AgentMessage | AgentMessage[],
	): void;

	compact(request: CompactRequest): Promise<CompactResult>;
	snapshot(): ContextSnapshot;
}
```

MVP 中一个 Context Manager 绑定一个 Agent，不在多个并发 Agent 之间共享。

具体的 Context Manager 可以通过构造函数接收初始 system prompts、已有消息以及 compact 策略：

```ts
const contextManager = new DefaultContextManager({
	systemPrompts,
	messages,
	compactor,
});
```

这些配置不进入 `AgentOptions`，Agent 也不感知 system prompt 的存储格式、拼接方式或来源。

### 7.2 Run-local Context

一次顶层运行使用一个 run-local context：

```ts
interface AgentContext {
	readonly systemPrompt: string;
	readonly messages: readonly AgentMessage[];
	readonly tools: readonly AgentTool[];
}
```

这是提供给 Model Runner 的统一只读视图。只有 Context Manager 可以创建或修改它。

`ContextManager.beginRun()` 负责：

```text
1. 读取 Context Manager 当前的 system prompts
2. 按 Context Manager 自己的规则生成最终 systemPrompt
3. 复制当前已提交的 context history
4. 在临时数据中追加本次 prompt messages
5. 接收本次运行已经实例化的 tools
6. 检查 signal
7. 同步、原子地提交新 history 和 run-local context
8. 立即返回 run-local AgentContext
```

`beginRun()` 采用 prepare/commit 两阶段语义：

```ts
async function beginRun(
	request: BeginRunContextRequest,
): Promise<AgentContext> {
	// Prepare：允许 await，但只构造临时数据，不修改已提交状态。
	const prepared = await awaitWithAbortCheck(
		prepareRunContext(request),
		request.signal,
	);

	request.signal.throwIfAborted();

	// Commit：必须同步、原子地完成；此后不再 await 或执行可失败工作。
	return commitPreparedRun(prepared);
}
```

具体规则：

- prepare 阶段可以加载和计算临时数据，但不能修改当前 context history 或发布不完整的 run-local context。
- prepare 阶段内部的每个 await 都必须在 finally 中检查 signal。
- prepare 失败或在 commit 前检测到取消时，`beginRun()` reject，Context Manager 的已提交状态完全不变。
- commit 前必须完成所有校验、复制和可能失败的计算。
- commit 必须是无 await 的短同步过程，同时更新当前 context history 和 run-local context。
- commit 完成后立即返回；不能再执行可能导致 `beginRun()` reject 的操作。

工具定义是 context 的独立字段，不伪装成 system message。

所有新增消息必须通过 Context Manager 提交：

```ts
contextManager.append(context, message);
```

`append()` 必须原子地更新当前 context history 和当前 run-local context。Agent 不直接执行 `context.messages.push()`。

向 `append()` 传入空数组是 no-op。

这保证：

- system prompt 只有一个所有者。
- context history 只有一个所有者。
- compact 前后的 context 切换只有一个所有者。
- Agent loop 只描述控制流，不描述 context 存储细节。

## 8. 运行入口和生命周期

所有可注入异步实现的 `await` 都必须通过同一个守卫执行。守卫在异步操作 resolve 或 reject 后、调用方继续处理结果之前，再次检查 active run 的 signal：

```ts
async function awaitWithAbortCheck<T>(
	operation: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	try {
		return await operation;
	} finally {
		signal.throwIfAborted();
	}
}
```

该守卫用于 tool 初始化、`beginRun()`、compact、LLM 和 `tool.execute()`。Agent 在这些顶层调用外使用守卫；Tool Manager、Context Manager、Model Runner 和 tool 的具体实现，在内部继续 `await` 子操作时也必须执行相同的 finally 检查。这样即使某个子操作忽略 signal 并正常返回，其结果也不能在取消后被继续处理或触发下一个异步步骤。

`awaitWithAbortCheck()` 只能阻止调用方继续消费返回值，不能撤销异步实现已经产生的外部副作用。因此：

- `beginRun()` 和 compact 必须在修改 Context Manager 状态前再次检查 signal，然后同步、原子地提交 mutation。
- tool 已经产生的外部副作用不回滚，但取消后返回的正常结果不提交为成功 tool result。
- 如果异步实现永不 settle，事后检查无法强制其中止，因此具体实现仍应主动监听 signal。

```ts
async function runPromptMessages(
	promptMessages: AgentInputMessage[],
): Promise<RunResult> {
	assertIdle();

	const activeRun = createActiveRun();
	activeRun.phase = "react";
	state.status = "running";
	state.lastError = undefined;

	try {
		const tools = await awaitWithAbortCheck(
			toolManager.instantiate(
				toolRequests,
				createToolInitContext(activeRun.signal),
			),
			activeRun.signal,
		);

		const context = await awaitWithAbortCheck(
			contextManager.beginRun({
				promptMessages,
				tools,
				signal: activeRun.signal,
			}),
			activeRun.signal,
		);
		return await awaitWithAbortCheck(
			runAgentLoop(context, activeRun),
			activeRun.signal,
		);
	} catch (error) {
		activeRun.phase = "closing";
		state.lastError = toError(error);
		throw error;
	} finally {
		activeRun.phase = "closing";
		steerQueue.clear();
		followUpQueue.clear();
		state.activeAssistantMessage = undefined;
		state.status = "idle";
		finishActiveRun();
	}
}
```

状态由这个生命周期包装层统一管理。`runAgentLoop()` 不直接修改 `state.status`。

无论成功、失败还是取消，`finally` 都必须在切换到 `idle` 之前同步关闭消息准入并清空两个队列。未注入 context 的 steer/follow-up 属于当前 active run，不得泄漏到下一次独立 `prompt()`。

准备顺序固定为：

```text
normalize prompt
→ ToolManager.instantiate()
→ ContextManager.beginRun()
→ runAgentLoop()
```

因此 tool 实例化失败时，本次 prompt 还没有进入当前 context history。

## 9. 双循环

外层循环只负责 follow-up；内层循环负责 tool calls 和 steer。

```ts
async function runAgentLoop(
	context: AgentContext,
	activeRun: ActiveRun,
): Promise<RunResult> {
	const { signal } = activeRun;

	while (true) {
		activeRun.phase = "react";
		await awaitWithAbortCheck(
			runReactLoop(context, activeRun),
			signal,
		);

		const followUps = followUpQueue.drain();
		if (followUps.length === 0) {
			// 必须在 async 函数返回前同步关闭准入。
			activeRun.phase = "closing";
			return createRunResult(context);
		}

		contextManager.append(context, followUps);
	}
}
```

内层循环：

```ts
async function runReactLoop(
	context: AgentContext,
	activeRun: ActiveRun,
): Promise<void> {
	const { signal } = activeRun;

	while (true) {
		signal.throwIfAborted();

		// Compact 时机 1：每次内层迭代开始、首次尝试调用 LLM 之前。
		await awaitWithAbortCheck(
			compactBeforeLlm(context, signal),
			signal,
		);

		const assistant = await awaitWithAbortCheck(
			runLlmWithCompactRecovery(context, signal),
			signal,
		);
		contextManager.append(context, assistant);

		const toolCalls = getToolCalls(assistant);
		for (let index = 0; index < toolCalls.length; index++) {
			const toolCall = toolCalls[index];

			try {
				signal.throwIfAborted();

				const toolResult = await awaitWithAbortCheck(
					executeToolCall(context, toolCall, signal),
					signal,
				);
				contextManager.append(context, toolResult);
			} catch (cause) {
				const error = toError(cause);
				if (!signal.aborted && error.name !== "AbortError") {
					throw error;
				}

				// 补齐 assistant message 中尚未产生结果的 tool calls，
				// 保证持久 context 不留下悬空的 tool call。
				contextManager.append(
					context,
					createCancellationToolResults(
						toolCalls.slice(index),
						signal.aborted ? signal.reason : error,
					),
				);

				if (signal.aborted) signal.throwIfAborted();
				throw error;
			}
		}

		const steering = steerQueue.drain();
		contextManager.append(context, steering);

		if (toolCalls.length === 0 && steering.length === 0) {
			// 必须在 async 函数返回前同步拒绝后续 steer，
			// 同时继续允许外层循环接收 follow-up。
			activeRun.phase = "follow_up";
			return;
		}
	}
}
```

`createCancellationToolResults()` 为尚未提交结果的 tool calls 一次性生成错误结果：

```ts
function createCancellationToolResults(
	pendingToolCalls: readonly ToolCall[],
	reason: unknown,
): ToolResultMessage[] {
	return pendingToolCalls.map((toolCall, index) => ({
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [{
			type: "text",
			text: index === 0
				? `Tool call cancelled: ${formatError(reason)}`
				: "Tool call skipped because the run was cancelled.",
		}],
		isError: true,
	}));
}
```

其中第一条表示检测到取消时的当前 tool call，之后的结果表示本轮尚未执行的 tool calls。它们只用于闭合已经提交的 assistant tool-call 结构；提交后仍然必须抛出取消错误，不能继续 ReAct loop。

内层退出条件必须同时满足：

```text
本轮没有 tool call
AND
本轮没有 steer message
```

## 10. Compact

Compact 是 Context Manager 的能力，不是 Agent 的独立依赖：

```ts
type CompactReason = "before_llm" | "llm_error";

interface CompactRequest {
	reason: CompactReason;
	context: AgentContext;
	error?: Error;
	signal: AbortSignal;
}

interface CompactResult {
	changed: boolean;
	beforeTokens?: number;
	afterTokens?: number;
}
```

Context Manager 内部可以委托给一个具体 Compactor，但这个实现细节不暴露给 Agent。

没有配置具体 compact 策略时，`ContextManager.compact()` 返回 `{ changed: false }`：

- LLM 调用前相当于跳过预防性 compact。
- LLM 报错后不做恢复性重试，直接抛出原错误。

如果 compact 发生，Context Manager 必须在 compactor 返回后和最终提交前检查 signal，然后原子地更新自己的 context history 和传入的 run-local context。signal 已 aborted 时保留 compact 前的 history。Agent 只读取 `changed`，不接触被替换的 messages。

### 10.1 时机一：每个 ReAct 迭代的首次 LLM 尝试前

每次内层循环迭代的第一步、首次尝试调用 LLM 前，调用：

```ts
async function compactBeforeLlm(
	context: AgentContext,
	signal: AbortSignal,
): Promise<CompactResult> {
	return await awaitWithAbortCheck(
		contextManager.compact({
			reason: "before_llm",
			context,
			signal,
		}),
		signal,
	);
}
```

这是预防性检查。Context Manager 可以根据 token 数判断不需要 compact，并返回：

```ts
{ changed: false }
```

“内层循环开始之前”在本 spec 中精确定义为：每次 ReAct 迭代开始、该迭代首次尝试调用 LLM 之前，而不是只在首次进入整个 `runReactLoop()` 时执行一次。恢复性 compact 后对同一次模型生成的重试不再重复执行预防性 compact。

### 10.2 时机二：LLM 调用报错后

LLM 抛错后，Agent 请求 Context Manager 发起一次恢复性 compact：

```ts
async function runLlmWithCompactRecovery(
	context: AgentContext,
	signal: AbortSignal,
): Promise<AssistantMessage> {
	try {
		return await runLlmAttempt(context, signal);
	} catch (cause) {
		// 取消优先于 provider error；不能只根据 error.name 判断。
		if (signal.aborted) signal.throwIfAborted();

		const error = toError(cause);
		if (error.name === "AbortError") throw error;

		const result = await awaitWithAbortCheck(
			contextManager.compact({
				reason: "llm_error",
				context,
				error,
				signal,
			}),
			signal,
		);

		if (!result.changed) {
			throw error;
		}

		// 同一次模型生成只允许恢复性重试一次；
		// 恢复重试前不再执行预防性 compact。
		return await runLlmAttempt(context, signal);
	}
}

async function runLlmAttempt(
	context: AgentContext,
	signal: AbortSignal,
): Promise<AssistantMessage> {
	const assistant = await awaitWithAbortCheck(
		modelRunner.run(context, { signal }),
		signal,
	);

	// Model Runner 可以通过 resolved AssistantMessage 表示 provider 失败。
	// Agent 必须在 append 前把失败状态转换成对应异常。
	if (assistant.stopReason === "aborted") {
		if (signal.aborted) signal.throwIfAborted();
		const error = new Error(assistant.errorMessage ?? "Model call aborted.");
		error.name = "AbortError";
		throw error;
	}

	if (assistant.stopReason === "error") {
		const error = new Error(assistant.errorMessage ?? "Model call failed.");
		error.name = "ModelError";
		throw error;
	}

	return assistant;
}
```

恢复规则：

- Context Manager 根据 `error` 和内部 compact 策略判断 compact 是否适用。
- 如果没有产生更小的新 context，原错误直接向上抛出。
- 如果 compact 成功，重试同一次 LLM 调用。
- 重试再次失败时直接向上抛出，不再次 compact。
- 每个 ReAct 迭代只在首次模型尝试前执行预防性 compact；恢复性 compact 后的重试不重复执行预防性 compact。
- signal 已 aborted 或模型抛出 `AbortError` 时，不执行恢复性 compact。
- Model Runner resolve 的 `stopReason: "error"` 在消息提交前转换成 `ModelError`，并按普通 LLM 错误执行上述恢复流程。
- Model Runner resolve 的 `stopReason: "aborted"` 在消息提交前转换成 `AbortError`，不执行恢复性 compact。
- LLM、compact 或其他可注入异步实现 resolve/reject 后，都必须先重新检查 signal，再读取、提交或继续处理其结果。
- compact 必须以原子方式提交；compact 自身失败时保留原 context history，并将 compact 错误作为本次运行错误。

该限制避免鉴权、网络、限流等非 context 错误触发无限 compact 循环。

## 11. 模型调用边界

```ts
interface ModelRunner {
	run(
		context: AgentContext,
		options: { signal: AbortSignal },
	): Promise<AssistantMessage>;
}
```

Model Runner 负责把统一的 `AgentContext` 转换成具体 provider 请求。

Model Runner 内部等待 provider 请求、stream event 或其他异步子操作时，每个 await 都必须在 finally 中检查传入的 signal。取消后不得继续组装或返回 `AssistantMessage`。

Model Runner 可以 reject，也可以 resolve 一个 `stopReason` 为 `"error"` 或 `"aborted"` 的 `AssistantMessage`。Agent 在把消息提交给 Context Manager 前检查这两个状态：`"error"` 转换成 `ModelError`，`"aborted"` 转换成 `AbortError`。失败消息本身不写入 context history。

Agent Core 不处理 Anthropic Messages、Chat Completions 或 Responses API 的字段差异。Provider adapter 负责协议转换，并把响应统一转换成 `AssistantMessage` 和 `ToolCall`。

## 12. 错误语义

### Tool 错误

以下错误转换成 `ToolResultMessage`，继续 ReAct loop：

- tool 不存在。
- arguments 校验失败。
- `tool.execute()` 抛出非取消错误。

取消的优先级高于普通 tool 错误：

- 每个 tool call 执行前必须检查 signal。
- `tool.execute()` 必须通过 `awaitWithAbortCheck()` 等待，因此 resolve 或 reject 后必须立即再次检查 signal。
- 如果 signal 已经 aborted，直接向上抛出 signal 对应的 `AbortError`。
- 如果 `tool.execute()` 抛出 `AbortError`，该错误直接向上抛出。
- 取消不转换成普通的 tool 执行错误，也不继续执行本轮剩余的 tool calls。
- 在向上抛出取消错误前，必须为当前以及本轮剩余的 tool calls 提交 cancelled/skipped `ToolResultMessage`，闭合已经写入 history 的 assistant tool-call 结构。

```ts
interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: MessageContent[];
	isError: boolean;
}
```

### LLM 错误

Model Runner reject，或者 resolve 一个 `stopReason: "error"` 的 assistant message，都按照第 10.2 节尝试一次 compact recovery。恢复失败则终止整个 run，`prompt()` reject。`stopReason: "aborted"` 按取消处理，不进入 compact recovery。

### Abort

- `abort()` 先同步把 active run 的 phase 切换为 `closing`，再触发它的 `AbortController`；从调用 `abort()` 开始不再接受新消息。
- LLM、Context Manager 和 tool 都接收同一个 signal。
- tool 初始化、`beginRun()`、compact、LLM 和 `tool.execute()` 的每个 await 都必须在内部 `finally` 中再次检查 signal。
- abort 不进入 compact recovery。
- abort 不转换成普通的 tool 执行错误。
- 检测到 abort 后，不再执行本轮剩余的 tool calls；当前及剩余调用只生成用于闭合 history 的 cancelled/skipped tool results。
- `prompt()` 以 `AbortError` reject。
- 已提交到 context history 的消息不回滚；此前已经成功 compact 的历史也不恢复。
- 未提交到 context history 的 steer/follow-up 在 `finally` 中清空，不得进入下一次 run。
- Agent 最终必须回到 `idle`。

## 13. 必须保持的运行不变量

1. 一个 Agent 最多只有一个 active run。
2. `running` 覆盖模型、工具、compact 和队列消费的完整生命周期。
3. 每个已提交的 assistant tool call 都必须恰好对应一个后续 tool result；取消时使用 cancelled/skipped result 闭合。
4. 同轮 steer 必须出现在全部 tool results 之后。
5. follow-up 只在内层 ReAct 收敛后注入。
6. 每个 ReAct 迭代的首次 LLM 尝试前执行一次预防性 compact；恢复重试不重复执行。
7. 每次失败的 LLM 调用最多执行一次恢复性 compact 和一次重试。
8. 队列消息只能提交一次。
9. run-local context 与 Context Manager 的 context history 中，已提交消息的相对顺序必须一致。
10. 无论成功、失败还是取消，最终状态必须恢复为 `idle`。
11. Agent 内不得保存 system prompts 或 context history 的副本。
12. Context Manager 是 system prompts、context history 和 compact mutation 的唯一所有者。
13. active run 跨过异步返回边界前，必须同步切换到正确的消息准入 phase。
14. 所有可注入异步实现返回后，必须先检查 signal，再提交或继续处理结果。
15. run 结束时两条消息队列必须清空，未提交消息不得跨 run 泄漏。

## 14. 未来扩展插槽

MVP 不实现通用 hook，但保留以下明确节点：

```text
P0  prompt 规范化之后
P1  tool 实例化之后
P2  每次内层迭代开始、首次 LLM 尝试之前
P3  LLM message 完成之后
P4  tool call 执行之前
P5  tool result 完成之后
P6  steer 注入之后
P7  内层 ReAct 收敛之后
P8  follow-up 注入之后
P9  run 结束之前
E1  LLM 报错之后、错误向上传递之前
```

当前 compact 固定占用：

- `P2`：每个 ReAct 迭代首次 LLM 尝试前的预防性 compact。
- `E1`：恢复性 compact。

以后加入 spec node 或 hook 时，不改变双循环和队列语义，只在这些边界增加可选行为。

## 15. MVP 验收场景

至少覆盖以下测试：

1. 普通 prompt：一次 LLM 调用后正常结束。
2. 单 tool call：LLM → tool → LLM → 结束。
3. 多 tool call：按输出顺序串行执行并回传结果。
4. tool 执行期间加入 steer：tool result 后注入 steer，再调用 LLM。
5. 无 tool call 但存在 steer：内层循环继续。
6. 内层结束时存在 follow-up：注入 follow-up，重新启动内层循环。
7. 多批 follow-up：外层循环逐批消费直至为空。
8. 每个 ReAct 迭代的首次 LLM 尝试前调用一次预防性 compact；恢复重试前不重复调用。
9. LLM 首次失败，恢复性 compact 改变 context，重试成功。
10. LLM 首次失败，恢复性 compact 未改变 context，直接失败。
11. compact 后的 LLM 重试再次失败，不产生第三次 LLM 调用。
12. abort 不触发恢复性 compact，最终状态回到 `idle`。
13. active run 期间再次调用 `prompt()` 被拒绝。
14. tool call、tool result、steer 在 context history 中的顺序满足不变量。
15. Agent state 中不存在 system prompt 或 messages 字段。
16. Context Manager 生成的 system prompt 正确进入每次 Model Runner context。
17. compact 后 Context Manager 的 context history 和当前 run-local context 同时更新，`snapshot()` 只返回 compact 后的历史。
18. tool 执行前 signal 已 aborted：不调用 tool，为当前及剩余调用提交 cancelled/skipped results，`prompt()` 以 `AbortError` reject。
19. tool 执行期间发生 abort，但 tool 忽略 signal 并正常返回：不提交其正常结果，为当前及剩余调用提交 cancelled/skipped results，然后以 `AbortError` reject。
20. `tool.execute()` 抛出 `AbortError`：为当前及剩余调用提交 cancelled/skipped results，然后终止 run。
21. `prompt()`、`steer()` 和 `followUp()` 拒绝 system、assistant 和 tool-result message；非法消息不进入队列或 context history。
22. 内层循环准备返回时插入 steer：phase 已同步切换为 `follow_up`，该 steer 被拒绝且不入队。
23. 外层循环确认 follow-up 为空后插入 follow-up：phase 已同步切换为 `closing`，该 follow-up 被拒绝且不入队。
24. LLM 执行期间发生 abort，但 Model Runner 忽略 signal 并正常返回：assistant message 不提交，`prompt()` 以 `AbortError` reject。
25. LLM 报错后、进入 recovery compact 前 signal 已 aborted：不调用 compact，`prompt()` 以 `AbortError` reject。
26. compact 执行期间发生 abort，但 compactor 忽略 signal 并正常返回：不提交 compact mutation、不调用后续 LLM，`prompt()` 以 `AbortError` reject。
27. tool 初始化或 `beginRun()` prepare 期间发生 abort，但子操作忽略 signal 并正常返回：不进入下一个生命周期步骤；`beginRun()` 不提交 prepared state，`prompt()` 以 `AbortError` reject。
28. run 失败或取消时两条队列仍有消息：`finally` 清空队列，下一次 `prompt()` 不会看到这些消息。
29. `beginRun()` prepare 抛错：当前 context history 和对外可见的 run-local context 均不发生变化。
30. `beginRun()` prepare 成功：新 history 和 run-local context 在一个无 await 的 commit 中同时生效，观察不到中间状态。
31. Model Runner resolve `stopReason: "error"`：失败消息不写入 history，按 LLM 错误执行一次 compact recovery。
32. Model Runner resolve `stopReason: "aborted"`：失败消息不写入 history，不执行 compact recovery，`prompt()` 以 `AbortError` reject。
