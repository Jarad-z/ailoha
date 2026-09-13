# Agent Tool 生命周期改动 Spec

## 1. 背景

当前 Agent 在每次顶层 `prompt()` 开始时调用：

```ts
toolManager.instantiate(toolRequests, {
	model,
	signal: activeRun.signal,
});
```

因此 Tool Factory 会在每次 run 中重新执行，生成新的 `AgentTool[]`。这会导致：

- 有状态 Tool 无法跨顶层 `prompt()` 保持状态；
- 浏览器、MCP client、数据库连接等昂贵资源被重复初始化；
- Tool 初始化错误被混入 run 生命周期；
- run 的 abort signal 同时承担 Tool 生命周期取消和单次运行取消两种职责；
- Tool 没有与 Agent 一起释放的明确生命周期。

本次改动把 Tool 实例生命周期提升为 Agent 生命周期。

## 2. 目标

改动后的对象关系为：

```text
Session
└─ Agent
   ├─ ModelRunner
   ├─ ContextManager
   └─ ToolManager
      └─ AgentTool[]
```

必须满足：

1. 一个 Session 只拥有一个 Agent。
2. 一个 Agent 只拥有一个 ToolManager。
3. Tool Factory 在 Agent 初始化期间最多调用一次。
4. 创建出的 `AgentTool[]` 在 Agent 的全部 `prompt()` 之间复用。
5. 单次 run 的 abort 不销毁、不重建 Tool。
6. Session/Agent dispose 时统一释放 Tool。
7. `prompt()` 不再负责实例化 Tool。

## 3. 非目标

本次不实现：

- 多 Agent Session；
- Tool 热插拔；
- Agent 运行期间注册或移除 Tool；
- 同一个 ToolManager 被多个 Agent 共享；
- Tool 状态持久化或进程重启恢复；
- 并行 Tool 执行；
- ModelRunner 和 ContextManager 的通用 dispose 协议。

## 4. 生命周期

```text
Session.create()
├─ 创建 Agent lifetime AbortController
├─ 创建 ModelRunner
├─ 创建 ContextManager
├─ 创建 ToolManager
├─ 注册 Tool Factory
├─ ToolManager.initialize()
│  └─ 创建并保存 AgentTool[]
└─ 创建 Agent

agent.prompt() #1
├─ 引用 ToolManager.tools
├─ ReAct / steer / follow-up
└─ run 结束，Tool 保留

agent.prompt() #2
├─ 继续引用同一组 ToolManager.tools
└─ Tool 内部状态继续保留

session.dispose()
├─ 停止接收新 prompt
├─ abort 当前 active run
├─ 等待 Agent idle
├─ ToolManager.dispose()
└─ abort Agent lifetime signal
```

对象生命周期表：

| 对象 | 生命周期 |
|---|---|
| Session | 会话生命周期 |
| Agent | 与 Session 相同 |
| ToolManager | 与 Agent 相同 |
| Tool Factory 注册表 | 与 ToolManager 相同 |
| AgentTool 实例 | 与 Agent 相同 |
| ToolCall | 单次模型输出 |
| ToolExecutionContext | 单次 Tool 执行 |
| run AbortSignal | 单次顶层 `prompt()` |
| agent lifetime AbortSignal | Session 创建至 dispose |

## 5. ToolManager 状态机

```ts
type ToolManagerStatus =
	| "configuring"
	| "initializing"
	| "ready"
	| "disposed";
```

状态转换：

```text
configuring
  ├─ register()
  └─ initialize()
       ↓
initializing
  ├─ success → ready
  └─ failure → disposed

ready
  ├─ tools getter
  └─ dispose() → disposed
```

约束：

- `register()` 只允许在 `configuring` 状态调用。
- `initialize()` 只能调用一次。
- `tools` 只允许在 `ready` 状态读取。
- `dispose()` 必须幂等。
- `disposed` 状态不允许注册、初始化或读取 Tool。

## 6. 类型改动

### 6.1 Tool 初始化上下文

Tool 初始化不再接收 run signal，而是接收 Agent 生命周期 signal：

```ts
interface ToolInitContext {
	readonly model: AgentModel;
	readonly signal: AbortSignal; // Agent lifetime signal
}
```

`ToolExecutionContext.signal` 仍然是当前 run signal：

```ts
interface ToolExecutionContext {
	readonly model: AgentModel;
	readonly context: AgentContext;
	readonly signal: AbortSignal; // current run signal
}
```

### 6.2 Tool 释放协议

Tool 可以选择实现异步释放：

```ts
interface AgentTool<TParameters extends TSchema = TSchema>
	extends Tool<TParameters> {
	execute(
		call: ToolCall,
		context: ToolExecutionContext,
	): Promise<ToolExecutionResult>;

	dispose?(): void | Promise<void>;
}
```

### 6.3 ToolManager API

```ts
class ToolManager {
	readonly status: ToolManagerStatus;

	register(name: string, factory: ToolFactory): void;

	initialize(
		requests: readonly ToolRequest[],
		context: ToolInitContext,
	): Promise<void>;

	get tools(): readonly AgentTool[];

	dispose(): Promise<void>;
}
```

`instantiate()` 从公开 API 中删除，内部可保留为私有方法：

```ts
#instantiateFactories(
	requests: readonly ToolRequest[],
	context: ToolInitContext,
): Promise<readonly AgentTool[]>;
```

### 6.4 AgentOptions

Agent 不再接收 `toolRequests`：

```ts
interface AgentOptions {
	readonly model: AgentModel;
	readonly modelRunner: ModelRunner;
	readonly contextManager: ContextManager;
	readonly toolManager: ToolManager; // 必须已经 ready
}
```

Agent 构造时必须验证：

```ts
if (options.toolManager.status !== "ready") {
	throw new AgentStateError(
		"Agent requires an initialized ToolManager.",
	);
}
```

## 7. Session 创建 API

因为 Tool Factory 可以是异步函数，Session 不能只依赖同步构造函数完成初始化。

Session 使用异步静态工厂：

```ts
class Session {
	readonly agent: Agent;

	private constructor(
		agent: Agent,
		lifetimeController: AbortController,
	) {}

	static async create(
		options: SessionOptions,
	): Promise<Session>;

	dispose(): Promise<void>;
}
```

调用方式：

```ts
const session = await Session.create({
	model,
	createModelRunner: () => modelRunner,
	contextManagerOptions: {
		systemPrompts: ["You are an assistant."],
	},
	configureTools(toolManager) {
		registerAgentTools(toolManager);
	},
	toolRequests: [
		{ name: "calculator" },
		{ name: "todo" },
	],
});

await session.agent.prompt("添加一个待办");
await session.agent.prompt("列出刚才的待办");

await session.dispose();
```

第二次 `prompt()` 必须看到第一次 `prompt()` 中 Tool 保存的状态。

## 8. Session.create() 顺序

初始化顺序固定为：

```text
validate SessionOptions
→ create agent lifetime controller
→ create ModelRunner
→ create ContextManager
→ create ToolManager
→ configure Tool factories
→ ToolManager.initialize()
→ create Agent
→ create Session
```

伪代码：

```ts
static async create(options: SessionOptions): Promise<Session> {
	const lifetimeController = new AbortController();
	const factoryContext = {
		model: options.model,
		signal: lifetimeController.signal,
	};

	try {
		const modelRunner = options.createModelRunner(factoryContext);
		const contextManager =
			options.createContextManager?.(factoryContext) ??
			new DefaultContextManager(options.contextManagerOptions);
		const toolManager =
			options.createToolManager?.(factoryContext) ??
			new ToolManager();

		options.configureTools?.(toolManager, factoryContext);

		await toolManager.initialize(
			options.toolRequests ?? [],
			{
				model: options.model,
				signal: lifetimeController.signal,
			},
		);

		const agent = new Agent({
			model: options.model,
			modelRunner,
			contextManager,
			toolManager,
		});

		return new Session(agent, lifetimeController);
	} catch (error) {
		lifetimeController.abort(error);
		throw error;
	}
}
```

## 9. Agent run 改动

当前 run 准备流程：

```text
ToolManager.instantiate()
→ ContextManager.beginRun()
→ runAgentLoop()
```

改为：

```text
ContextManager.beginRun({
  promptMessages,
  tools: ToolManager.tools,
})
→ runAgentLoop()
```

对应伪代码：

```ts
async #runPromptMessages(
	promptMessages: AgentInputMessage[],
	activeRun: ActiveRun,
): Promise<RunResult> {
	try {
		const context = await awaitWithAbortCheck(
			this.#contextManager.beginRun({
				promptMessages,
				tools: this.#toolManager.tools,
				signal: activeRun.signal,
			}),
			activeRun.signal,
		);

		return await awaitWithAbortCheck(
			this.#runAgentLoop(context, activeRun),
			activeRun.signal,
		);
	} finally {
		// 结束 run，但不 dispose ToolManager 或 AgentTool。
	}
}
```

## 10. Tool 执行语义

Agent 继续从当前 Context 中查找 Tool：

```ts
const tool = context.tools.find(
	(candidate) => candidate.name === call.name,
);
```

以下语义保持不变：

- 多个 ToolCall 仍按模型输出顺序串行执行；
- Tool 执行使用当前 run signal；
- Tool 普通错误转换成 `ToolResultMessage`；
- Tool abort 终止当前 run；
- 已提交的 ToolCall 必须用 ToolResult 闭合；
- steer 在本轮全部 ToolResult 后注入；
- follow-up 在当前 ReAct 内层循环收敛后注入。

## 11. 初始化失败

Tool 初始化必须具备原子语义：

- 任意 Factory 失败时，Session 创建失败；
- Agent 不得被创建或暴露；
- 已成功创建的 Tool 按创建顺序的逆序调用 `dispose()`；
- ToolManager 进入 `disposed` 状态；
- Agent lifetime signal 被 abort；
- 原始初始化错误向调用方抛出。

如果清理也失败，保留初始化错误为主错误，清理错误通过 `AggregateError` 或 `cause` 暴露，不覆盖原错误。

## 12. Dispose 语义

`Session.dispose()` 必须：

1. 幂等；
2. 同步阻止新的 `prompt()`；
3. 如果 Agent 正在运行，调用 `agent.abort()`；
4. 等待 `agent.waitForIdle()`；
5. 按创建顺序的逆序调用每个 Tool 的 `dispose()`；
6. 清空 ToolManager 对 Tool 的引用；
7. abort Agent lifetime signal；
8. 即使一个 Tool dispose 失败，也继续释放剩余 Tool；
9. 全部释放后用 `AggregateError` 报告 dispose 错误。

单次 `agent.abort()` 不得调用 Tool dispose。

## 13. 运行不变量

改动后必须保持以下不变量：

1. 一个 Session 恰好拥有一个 Agent。
2. 一个 Agent 恰好拥有一个 ToolManager。
3. Agent 构造时 ToolManager 已处于 `ready`。
4. 每个 ToolRequest 对应的 Factory 在 Agent 生命周期内最多成功创建一个 Tool 实例。
5. 所有顶层 `prompt()` 读取同一个只读 `AgentTool[]`。
6. Tool 列表在 Agent 创建后不可改变。
7. run abort 不改变 ToolManager 的 `ready` 状态。
8. run 失败不自动重建 Tool。
9. steer 和 follow-up 使用当前 Agent 的同一组 Tool 实例。
10. Session dispose 后不得再次调用 `prompt()` 或执行 Tool。
11. 每个成功创建的可释放 Tool 最多调用一次 `dispose()`。
12. Tool 初始化或释放不能污染 Context history。

## 14. 验收测试

至少增加以下测试：

1. `Session.create()` 为每个 ToolRequest 调用一次 Factory。
2. 连续执行两个顶层 `prompt()`，Factory 调用次数仍为一次。
3. 两次 `prompt()` 获得的 `context.tools[0]` 是同一对象。
4. 有状态 todo Tool 在第二次 `prompt()` 中能读取第一次写入的数据。
5. 同一次 run 的 steer 使用同一个 Tool 实例。
6. 同一次 run 的 follow-up 使用同一个 Tool 实例。
7. run 成功后 ToolManager 保持 `ready`。
8. run 普通失败后 ToolManager 保持 `ready`。
9. run abort 后 ToolManager 保持 `ready`，下一次 prompt 可以继续使用。
10. Tool Factory 异步初始化成功后才创建 Agent。
11. Tool Factory 初始化失败时不返回 Session。
12. 第 N 个 Tool 初始化失败时，前 N-1 个 Tool 被逆序释放。
13. Agent 不能使用未初始化的 ToolManager 构造。
14. `register()` 在 ToolManager ready 后被拒绝。
15. `initialize()` 第二次调用被拒绝。
16. `Session.dispose()` 释放所有 Tool。
17. `Session.dispose()` 调用两次时每个 Tool 只释放一次。
18. active run 期间 dispose 会先 abort run，再释放 Tool。
19. 一个 Tool dispose 失败不会阻止其他 Tool dispose。
20. dispose 完成后新的 prompt 被拒绝。

## 15. 迁移步骤

建议按以下顺序实施：

1. 给 `ToolManager` 增加状态机、`initialize()`、`tools` 和 `dispose()`。
2. 给 `AgentTool` 增加可选 `dispose()`。
3. 从 `AgentOptions` 删除 `toolRequests`。
4. 从 `Agent.#runPromptMessages()` 删除 `ToolManager.instantiate()`。
5. Agent 改为使用 `this.#toolManager.tools`。
6. 把 Session 改为 `await Session.create(options)`。
7. Session 创建期间初始化 ToolManager。
8. 增加 Session dispose 生命周期。
9. 更新现有 Agent 测试，使测试 ToolManager 在构造 Agent 前完成初始化。
10. 增加本 Spec 第 14 节的生命周期测试。

## 16. 最终调用示例

```ts
const session = await Session.create({
	model,
	createModelRunner: () => modelRunner,
	contextManagerOptions: {
		systemPrompts: ["You are an assistant."],
	},
	configureTools(manager) {
		manager.register("calculator", () => createCalculatorTool());
		manager.register("todo", () => createTodoTool());
	},
	toolRequests: [
		{ name: "calculator" },
		{ name: "todo" },
	],
});

await session.agent.prompt("添加待办：完成 Tool 生命周期改造");
await session.agent.prompt("列出待办");

await session.dispose();
```

预期结果：第二次 prompt 使用与第一次完全相同的 todo Tool 实例，并能读取第一次写入的状态。
