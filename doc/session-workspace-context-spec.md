# Session Workspace Context Spec

## 1. 背景

当前 `Session` 负责创建一个 `Agent` 以及它使用的 `ModelRunner`、`ContextManager` 和
`ToolManager`，但 Session 没有记录当前工作目录。`DefaultContextManager` 因而无法在
system prompt 中告诉模型本次会话对应哪个 workspace。

具体问题：

```text
process cwd = D:\ailoha
Session.create()
└─ DefaultContextManager
   └─ systemPrompt 中没有 workspace 信息
```

模型只能从用户消息或 Tool 的额外上下文中猜测工作目录。进程 cwd 如果在 Session 创建后
发生变化，还可能让同一个会话的 workspace 语义漂移。

本次设计在 Session 层增加稳定的 `workspace` 快照，由 ContextManager 消费，并最终写入
每次 run 的 system prompt。

## 2. 核心决定

Session 使用一个结构化的 `workspace` 字段：

```ts
interface SessionWorkspace {
	readonly cwd: string;
}

class Session {
	readonly workspace: SessionWorkspace;
	readonly agent: Agent;
}
```

不同时增加 `session.cwd`。`session.workspace.cwd` 是当前会话工作目录的唯一数据源。

选择结构化字段而不是直接使用 `workspace: string`，是为了以后可以在不增加 Session
平级字段的情况下扩展 workspace 元数据，例如 repository root 或 workspace name。本 Spec
只实现 `cwd`，不提前加入其他字段。

## 3. 目标

必须满足：

1. 每个 Session 保存一个稳定、只读的 workspace 快照。
2. `workspace.cwd` 是规范化后的绝对路径。
3. Session 创建出的默认 ContextManager 消费该 workspace。
4. 自定义 ContextManager Factory 能在创建时取得同一个 workspace 对象。
5. workspace 信息最终出现在每次 run 的 system prompt 中。
6. workspace 不写入 message history，不产生伪造的 user 或 assistant message。
7. 多次 `prompt()`、steer、follow-up 和 compact 使用同一个 workspace。
8. Session 创建后，进程 cwd 变化不影响该 Session。

## 4. 非目标

本次不实现：

- workspace 文件扫描或目录树注入；
- 自动寻找 Git repository root；
- 多 workspace Session；
- Session 运行期间切换 cwd；
- workspace 访问权限或 sandbox 策略；
- 把环境变量、用户名或文件内容写入 system prompt；
- workspace 在进程重启后的持久化；
- system prompt 的最终文案、标签格式和提示词顺序。

最后一项是当前明确的待设计内容，见第 10 节。

## 5. 类型改动

### 5.1 Workspace 类型

输入和解析后的类型分开：

```ts
interface SessionWorkspaceOptions {
	readonly cwd?: string;
}

interface SessionWorkspace {
	readonly cwd: string;
}
```

`SessionWorkspaceOptions.cwd` 可以是相对路径；`SessionWorkspace.cwd` 必须是绝对路径。

### 5.2 SessionOptions

```ts
interface SessionOptions {
	readonly model: AgentModel;
	readonly workspace?: SessionWorkspaceOptions;
	readonly createModelRunner: (
		context: SessionFactoryContext,
	) => ModelRunner;
	// 其他现有字段保持不变。
}
```

解析规则：

```ts
const cwd = path.resolve(options.workspace?.cwd ?? process.cwd());
const workspace = Object.freeze({ cwd });
```

约束：

- 显式传入的 `cwd` 不能为空字符串；
- `cwd` 不允许包含 NUL 字符；
- 只做字符串规范化，不在 core 层检查路径是否存在、是否为目录或是否可访问；
- 默认 cwd 在 `Session.create()` 开始时读取一次，不能在每次 run 时重新读取。

路径存在性属于实际执行环境或 Tool 的职责。避免在 core 中做文件系统探测，可以支持尚未挂载、
远程映射或由宿主环境管理的 workspace。

### 5.3 SessionFactoryContext

```ts
interface SessionFactoryContext {
	readonly model: AgentModel;
	readonly signal: AbortSignal;
	readonly workspace: SessionWorkspace;
}
```

`createModelRunner`、`createContextManager`、`createToolManager` 和 `configureTools` 收到的
Factory Context 必须引用同一个冻结的 `SessionWorkspace` 对象。

这允许自定义 ContextManager 消费 workspace，也允许未来的 Tool Factory 使用 cwd，但不改变
Tool 执行生命周期。

### 5.4 Session

```ts
class Session {
	readonly workspace: SessionWorkspace;
	readonly agent: Agent;

	private constructor(
		agent: Agent,
		lifetimeController: AbortController,
		workspace: SessionWorkspace,
	) {}
}
```

Session 必须直接暴露最终解析后的 workspace，方便宿主层显示或诊断当前会话作用域。

## 6. 数据流

改动后的对象关系：

```text
Session.create(options)
├─ resolveWorkspace(options.workspace, process.cwd())
│  └─ SessionWorkspace { cwd: absolutePath }
├─ SessionFactoryContext
│  └─ workspace ───────────────┐
├─ createModelRunner(context)  │
├─ createContextManager(context) ── custom ContextManager
│                              │
├─ DefaultContextManagerOptions
│  └─ workspace ◀──────────────┘
├─ Agent
└─ Session.workspace

DefaultContextManager.beginRun()
├─ configured system prompts
├─ render workspace system prompt
├─ join system prompts
└─ AgentContext.systemPrompt
```

Session 是 workspace 的所有者，ContextManager 是 system prompt 表达方式的所有者。Agent
不需要保存第二份 workspace，也不需要在每次 `beginRun()` 时重新传递 cwd。

## 7. DefaultContextManager 改动

`DefaultContextManagerOptions` 增加已经解析完成的 workspace：

```ts
interface DefaultContextManagerOptions {
	readonly workspace?: SessionWorkspace;
	readonly systemPrompts?: readonly SystemPrompt[];
	// 其他现有字段保持不变。
}
```

Session 创建默认 ContextManager 时必须覆盖式写入 Session 的 workspace：

```ts
const contextManager =
	options.createContextManager?.(factoryContext) ??
	new DefaultContextManager({
		...options.contextManagerOptions,
		workspace,
	});
```

即使未来 `contextManagerOptions` 可以由外部组合生成，也不能覆盖 Session 已解析的 workspace，
避免 `session.workspace.cwd` 与 system prompt 中的 cwd 不一致。

DefaultContextManager 在构造时保存 workspace。每次 `beginRun()` 基于保存的同一个 workspace
构造有效 system prompt，不读取 `process.cwd()`。

直接构造 `DefaultContextManager` 时，`workspace` 可以省略；省略表示不注入 workspace prompt。
通过 `Session.create()` 创建的默认 ContextManager 必须始终收到 workspace，包括调用方没有显式
传入 `SessionOptions.workspace` 的情况。

### 7.1 System prompt 组装约束

虽然最终提示词文案尚未设计，但组装行为先固定为：

1. workspace 被渲染成一个独立的 system prompt fragment；
2. fragment 在一次 `beginRun()` 中最多出现一次；
3. 多次 run 不累积或重复追加 fragment；
4. `AgentContext.systemPrompt` 包含该 fragment；
5. `CompactorInput.systemPrompt` 继续取得完整的有效 system prompt，因此也包含 workspace；
6. workspace fragment 不进入 `ContextState.messages`；
7. `snapshot().messages` 不因 workspace 注入发生变化；
8. 路径必须作为数据转义，不能让路径中的换行、引号或标签字符改变提示词结构。

建议实现一个私有纯函数，暂不公开 formatter API：

```ts
function renderWorkspaceSystemPrompt(
	workspace: SessionWorkspace,
): SystemPrompt {
	// TODO(prompt-design): 确定最终文案、边界标记和转义格式。
}
```

在最终提示词格式确定前，不把 `formatWorkspacePrompt` 暴露为公共配置项，避免尚未稳定的提示词
结构成为需要长期维护的 API。

## 8. Session.create() 顺序

初始化顺序更新为：

```text
validate SessionOptions
→ resolve and freeze SessionWorkspace
→ create agent lifetime controller
→ create SessionFactoryContext（包含 workspace）
→ create ModelRunner
→ create ContextManager（消费 workspace）
→ create ToolManager
→ configure and initialize ToolManager
→ create Agent
→ create Session（保存同一个 workspace）
```

workspace 输入验证必须发生在任何 Factory 被调用之前。无效 cwd 不得产生 ModelRunner、
ContextManager 或 Tool 的初始化副作用。

伪代码：

```ts
static async create(options: SessionOptions): Promise<Session> {
	validateOptions(options);
	const workspace = resolveWorkspace(options.workspace);
	const lifetimeController = new AbortController();
	const factoryContext = Object.freeze({
		model: options.model,
		signal: lifetimeController.signal,
		workspace,
	});

	try {
		const modelRunner = options.createModelRunner(factoryContext);
		const contextManager =
			options.createContextManager?.(factoryContext) ??
			new DefaultContextManager({
				...options.contextManagerOptions,
				workspace,
			});

		// ToolManager 初始化逻辑保持不变。

		const agent = new Agent({
			model: options.model,
			modelRunner,
			contextManager,
			toolManager,
		});

		return new Session(agent, lifetimeController, workspace);
	} catch (error) {
		// 现有原子清理语义保持不变。
		throw error;
	}
}
```

## 9. 运行不变量

实现后必须保持：

1. `session.workspace` 与所有 Session Factory 看到的 `context.workspace` 是同一对象。
2. `session.workspace` 和 `context.workspace` 均不可变。
3. `session.workspace.cwd` 在 Session 生命周期内不变化。
4. 默认 ContextManager 使用的 workspace 与 `session.workspace` 一致。
5. 一个顶层 `prompt()` 只生成一个 workspace fragment。
6. 不同顶层 `prompt()` 使用相同 cwd。
7. steer 和 follow-up 不生成新的 workspace 或修改 system prompt。
8. compact 前后 workspace 信息保持存在。
9. run abort 或失败不清除 workspace。
10. Session dispose 不需要单独释放 workspace，也不能引入文件系统副作用。
11. workspace 不污染 message history。
12. workspace 的加入不改变 ToolManager 和 AgentTool 的生命周期。

## 10. System prompt 待设计项

以下内容本 Spec 暂不决定，实施 system prompt 注入前需要单独确认：

1. 最终文案，例如使用“current working directory”还是“workspace root”；
2. 使用纯文本、XML-like 标签还是 JSON 数据块；
3. workspace fragment 放在调用方 `systemPrompts` 之前还是之后；
4. Windows 路径的展示方式和转义规则；
5. 是否明确告诉模型相对路径必须基于该 cwd 解析；
6. 是否声明 cwd 只描述会话上下文，不代表 Tool 一定有文件系统权限。

无论选择哪种文案，都必须满足第 7.1 节的安全和稳定性约束。特别是 cwd 必须按数据处理，
不能直接拼接成可能被解释为额外指令的自由文本。

在这些问题确定前，可以完成 Session workspace 的类型、解析和 ContextManager 传递，但不应合入
带临时文案的 system prompt 行为。

## 11. 验收测试

### 11.1 Workspace 解析与所有权

1. 未提供 workspace 时，`session.workspace.cwd` 是 Session 创建时 `process.cwd()` 的绝对路径。
2. 显式相对 cwd 被规范化为绝对路径。
3. 显式绝对 cwd 保持同一语义。
4. 空字符串和含 NUL 的 cwd 在 Factory 执行前被拒绝。
5. workspace 对象被冻结。
6. 所有 Session Factory 收到同一个 workspace 对象。
7. Session 创建后改变进程 cwd，不改变 `session.workspace.cwd`。
8. Session 不检查 cwd 是否真实存在。

### 11.2 ContextManager 消费

9. 默认 ContextManager 收到的 workspace 与 `session.workspace` 相同。
10. 自定义 ContextManager Factory 可以读取 `context.workspace.cwd`。
11. Session workspace 不能被 `contextManagerOptions` 中的不同值覆盖。

### 11.3 System prompt

最终提示词方案确定后补充精确断言：

12. 第一次 `prompt()` 的 `AgentContext.systemPrompt` 包含规范化 cwd。
13. 连续两个顶层 `prompt()` 都只包含一个 workspace fragment。
14. steer 和 follow-up 使用相同的完整 system prompt。
15. compact 接收的 system prompt 包含 workspace fragment。
16. cwd 不出现在 message history 中。
17. 包含换行、引号和标签字符的 cwd 不能逃逸 workspace 数据边界。
18. 调用方没有配置其他 system prompt 时，workspace fragment 仍然生效。
19. 直接构造且未提供 workspace 的 `DefaultContextManager` 保持现有行为。

## 12. 迁移步骤

建议按以下顺序实施：

1. 增加 `SessionWorkspaceOptions` 和 `SessionWorkspace` 类型。
2. 增加独立、可单测的 workspace 解析函数。
3. 给 `SessionOptions` 和 `SessionFactoryContext` 增加 workspace。
4. 让 Session 保存并公开解析后的 workspace。
5. 把 workspace 注入默认 ContextManager，并提供给自定义 ContextManager Factory。
6. 增加第 11.1、11.2 节测试。
7. 确认第 10 节的 system prompt 方案。
8. 实现私有 workspace prompt renderer。
9. 增加第 11.3 节测试。
10. 更新 README 和 Session 调用示例。

## 13. 最终调用形态

```ts
const session = await Session.create({
	model,
	workspace: {
		cwd: "D:\\ailoha",
	},
	createModelRunner: () => modelRunner,
	contextManagerOptions: {
		systemPrompts: ["You are an assistant."],
	},
});

console.log(session.workspace.cwd); // D:\ailoha
await session.agent.prompt("检查当前项目");
await session.dispose();
```

预期结果：ContextManager 构造的 system prompt 包含该 Session 的 workspace 信息；具体提示词
文本和边界格式在第 10 节的设计完成后确定。
