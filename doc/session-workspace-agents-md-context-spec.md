# Session Workspace 与 `AGENTS.md` Context 注入 Spec

状态：Implemented（2026-09-13）

适用范围：`@ailoha/agent-core`、`@ailoha/agent-service`

本文补全并替代 `session-workspace-context-spec.md` 中尚未确定的 workspace system prompt
部分。旧文档可以保留为背景材料；实现和验收以本文为准。

真实 Provider 调用案例见
[`session-workspace-agents-md-live-e2e-test-plan.md`](./session-workspace-agents-md-live-e2e-test-plan.md)。

## 1. 背景

当前 `Session` 没有 workspace 概念。`DefaultContextManager` 只保存调用方传入的
`systemPrompts: string[]`，每次 `beginRun()` 使用 `"\n\n"` 拼成一个
`AgentContext.systemPrompt`。当前工作目录、workspace 指令文件和其他 Session 元数据都不会
自动进入模型上下文。

目标行为是：

```text
Session.create({ workspace: { cwd } })
└─ Session.workspace.cwd
   └─ DefaultContextManager.beginRun()
      ├─ 读取已配置的 systemPrompts
      ├─ 读取 <cwd>/AGENTS.md
      ├─ 生成 workspace system prompt fragment
      └─ 得到本次 Run 固定的 AgentContext.systemPrompt
```

`AGENTS.md` 的内容会以 system-level 指令发送给模型，因此它不是普通的 dotenv 文件，也不是
进程环境变量来源。

## 2. 核心决定

### 2.1 Session 持有稳定的 workspace

```ts
export interface SessionWorkspaceOptions {
	readonly cwd?: string;
}

export interface SessionWorkspace {
	readonly cwd: string;
}
```

`Session` 增加：

```ts
class Session {
	readonly workspace: SessionWorkspace;
	readonly agent: Agent;
}
```

`workspace.cwd` 在 `Session.create()` 开始时解析一次，之后保持不变。默认值是当时的
`process.cwd()`，不是每次 Run 开始时重新读取的进程 cwd。

### 2.2 `AGENTS.md` 是纯文本指令文件

本期把 `<workspace.cwd>/AGENTS.md` 定义为：

- UTF-8 编码的纯文本 system prompt fragment；
- 不使用 dotenv 语法解析；
- 不展开 `${VAR}`、`%VAR%` 或 shell 表达式；
- 不修改 `process.env`；
- 不向上查找父目录，也不扫描子目录；
- 文件不存在时等同于没有 workspace 指令；
- 文件存在但无法安全读取时，本次 Run 失败。

虽然文件名带有 `.env`，但它不得存放 API key、token、密码或其他秘密。它的正文会发送给模型
Provider，也可能在显式开启 debug trace 时进入诊断记录。

### 2.3 每个顶层 Run 读取一次

`AGENTS.md` 在 `DefaultContextManager.beginRun()` 的 prepare 阶段读取：

- 同一个顶层 `prompt()` 内只读取一次；
- tool loop、steer 和 follow-up 继续使用本次 Run 已生成的同一个 system prompt；
- 下一个顶层 `prompt()` 重新读取，因此 Session 运行期间对 `AGENTS.md` 的修改在下一次 Run 生效；
- 文件在 Run 进行中发生变化，不影响当前 Run；
- 自动 compact 使用当前 Run 的 system prompt；
- idle 状态下的手动 compact 重新读取当前 `AGENTS.md`。

这样同时保证单次 Run 的一致性和跨 Run 的可更新性。

### 2.4 拼接顺序固定

有效 fragments 的顺序为：

```text
调用方配置的 systemPrompts，保持原顺序
→ AGENTS.md 渲染出的 workspace fragment（如果存在且非空）
```

最终仍使用现有 `joinSystemPrompts`；默认结果是 fragments 之间两个换行：

```ts
joinSystemPrompts(effectiveFragments); // default: fragments.join("\n\n")
```

workspace fragment 的固定格式为：

```text
Workspace-specific instructions loaded from AGENTS.md follow. They apply to this workspace and may refine, but must not override, earlier system instructions.

<AGENTS.md 原始正文>
```

约束：

- 不把绝对 cwd 写入模型 prompt，避免不必要地泄露宿主路径；
- `AGENTS.md` 是受信任的指令正文，因此正文不做 XML/JSON 转义；
- 移除 UTF-8 BOM；
- 将 CRLF 和单独 CR 规范化为 LF；
- 保留正文其余字符；
- 正文仅包含空白时不生成 fragment；
- 不允许 `AGENTS.md` 覆盖调用方更高层的 system 规则。

当前 Context API 会把所有 fragments 拍平成一个 `system` message，无法从协议层强制 fragment
优先级。上面的桥接文案是本期的显式冲突规则；未来如果 Context 支持结构化
`system`/`developer` 指令来源，再迁移为结构化优先级。

## 3. 目标

实现必须满足：

1. 每个 Session 暴露稳定、只读的 `workspace.cwd`。
2. `workspace.cwd` 是规范化后的绝对路径。
3. 默认 ContextManager 能访问 Session 的同一个 workspace 对象。
4. 自定义 Session factories 能访问同一个 workspace 对象。
5. 每个顶层 Run 从 workspace 根目录读取一次 `AGENTS.md`。
6. 有效 `AGENTS.md` 内容作为最后一个 workspace system prompt fragment。
7. workspace fragment 不进入 message history。
8. 同一个 Run 的所有 LLM 调用使用完全相同的 system prompt。
9. 下一次顶层 Run 可以读取到更新后的 `AGENTS.md`。
10. compact 前后 workspace 指令仍然有效。
11. 文件读取失败不能造成半提交的用户消息或 Context history。
12. 工具定义继续通过 `AgentContext.tools` 和 Provider 的 `tools` 字段传递。
13. 缺少 `AGENTS.md` 时保持现有 system prompt 行为。

## 4. 非目标

本期不实现：

- `AGENTS.local.md`、dotenv 文件或其他备用文件名；仅固定读取 workspace 根目录的 `AGENTS.md`；
- 从当前目录向父目录递归发现指令文件；
- 多 workspace Session；
- Session 运行中切换 cwd；
- 解析 dotenv 键值、导入环境变量或变量替换；
- workspace 文件树、Git 状态或任意文件内容注入；
- 根据子目录给指令增加作用域；
- 将 `AGENTS.md` 内容保存到 Transcript；
- 自动从不可信远程仓库启用 system-level 指令；
- Provider 级 `system`/`developer` role 重构。

## 5. Workspace 解析

新增纯函数，建议放在 `packages/agent-core/src/workspace.ts`：

```ts
export function resolveSessionWorkspace(
	input: SessionWorkspaceOptions | undefined,
	fallbackCwd: string,
): SessionWorkspace;
```

解析规则：

```ts
const source = input?.cwd ?? fallbackCwd;
const cwd = path.resolve(source);
return Object.freeze({ cwd });
```

在调用 `path.resolve()` 前必须拒绝：

- 空字符串或仅包含空白的 cwd；
- 包含 NUL 字符的 cwd；
- 非字符串值。

Core 层不要求路径在 Session 创建时已经存在，也不检查它是否为目录。这样可以支持稍后挂载或
由宿主控制的 workspace。真正读取 `AGENTS.md` 时再处理文件系统错误。

## 6. 类型与生命周期改动

### 6.1 `SessionOptions`

```ts
export interface SessionOptions {
	readonly model: AgentModel;
	readonly workspace?: SessionWorkspaceOptions;
	// 其他现有字段保持不变。
}
```

### 6.2 `SessionFactoryContext`

```ts
export interface SessionFactoryContext {
	readonly sessionId: SessionId;
	readonly model: AgentModel;
	readonly workspace: SessionWorkspace;
	readonly signal: AbortSignal;
}
```

`createModelRunner`、`createContextManager`、`createToolManager` 和 `configureTools` 必须收到同一个
冻结的 workspace 对象。

### 6.3 `DefaultContextManagerOptions`

```ts
export interface DefaultContextManagerOptions {
	readonly workspace?: SessionWorkspace;
	readonly systemPrompts?: readonly SystemPrompt[];
	readonly loadWorkspaceInstructions?: WorkspaceInstructionLoader;
	// 其他现有字段保持不变。
}
```

`loadWorkspaceInstructions` 是可注入的读取边界，方便单测、远程文件系统或宿主自定义；默认实现从
本地文件系统读取固定文件 `AGENTS.md`。它不是更改文件名或加载任意文件的公开入口。

```ts
export interface WorkspaceInstructionLoadRequest {
	readonly workspace: SessionWorkspace;
	readonly signal: AbortSignal;
}

export interface WorkspaceInstructionFile {
	readonly content: string;
	readonly byteLength: number;
	readonly sha256: string;
}

export type WorkspaceInstructionLoader = (
	request: WorkspaceInstructionLoadRequest,
) => Promise<WorkspaceInstructionFile | undefined>;
```

自定义 loader 返回的 `content` 也必须经过统一的 BOM、换行和空白检查，不能绕过 ContextManager
的规范化与大小限制。

### 6.4 `Session.create()`

创建顺序调整为：

```ts
const workspace = resolveSessionWorkspace(
	options.workspace,
	process.cwd(),
);

const factoryContext = Object.freeze({
	sessionId,
	model: options.model,
	workspace,
	signal: lifetimeController.signal,
});

const contextManager =
	options.createContextManager?.(factoryContext) ??
	new DefaultContextManager({
		...options.contextManagerOptions,
		workspace,
	});
```

Session 解析出的 workspace 必须最后覆盖 `contextManagerOptions` 中可能存在的值，避免
`session.workspace` 与 system prompt 实际读取位置不一致。

`Session` 构造函数保存同一个对象：

```ts
return new Session(
	sessionId,
	agent,
	lifetimeController,
	workspace,
	ownedTraceSink,
);
```

## 7. `AGENTS.md` 文件读取规则

### 7.1 路径

唯一候选路径是：

```ts
path.join(workspace.cwd, "AGENTS.md")
```

不得读取以下位置：

- 父目录中的 `AGENTS.md`；
- 当前进程 cwd 中的同名文件，除非它就是 Session workspace；
- 由 `AGENTS.md` 正文引用的其他文件；
- 大小写或名称不同的备用文件。

### 7.2 文件约束

默认最大文件大小为 64 KiB，以 UTF-8 字节数计算。Loader 最多读取 `64 KiB + 1 byte`，不能先把
任意大的文件完整载入内存再检查。

候选必须是普通文件：

- `ENOENT`：返回 `undefined`，Run 继续；
- 目录、socket、device 或符号链接：拒绝；
- 超过 64 KiB：拒绝；
- 非法 UTF-8：拒绝；
- `EACCES`、`EPERM`、I/O 错误：拒绝；
- 读取期间收到 abort：抛出标准 `AbortError`。

本期拒绝符号链接，避免 workspace 内的 `AGENTS.md` 在不明显的情况下指向 workspace 外部文件。
如果以后需要支持 symlink，应单独定义 `realpath`、containment 和 TOCTOU 语义。

### 7.3 错误类型

新增：

```ts
export type WorkspaceContextErrorCode =
	| "WORKSPACE_CWD_INVALID"
	| "WORKSPACE_INSTRUCTIONS_UNREADABLE"
	| "WORKSPACE_INSTRUCTIONS_TOO_LARGE"
	| "WORKSPACE_INSTRUCTIONS_INVALID_UTF8"
	| "WORKSPACE_INSTRUCTIONS_NOT_REGULAR_FILE";

export class WorkspaceContextError extends Error {
	readonly code: WorkspaceContextErrorCode;
	readonly fileName = "AGENTS.md";
}
```

错误消息可以包含文件名和错误类别，但默认不得把文件正文写进错误或 trace。

## 8. Context 拼装算法

### 8.1 `beginRun()`

推荐实现：

```ts
async beginRun(request: BeginRunContextRequest): Promise<AgentContext> {
	const snapshot = this.snapshot();

	if (this.#prepareRun) {
		await awaitWithAbortCheck(
			Promise.resolve(this.#prepareRun(request, snapshot)),
			request.signal,
		);
	}

	const workspaceFile = this.#workspace
		? await awaitWithAbortCheck(
				this.#loadWorkspaceInstructions({
					workspace: this.#workspace,
					signal: request.signal,
				}),
				request.signal,
			)
		: undefined;

	const workspaceFragment = workspaceFile
		? renderWorkspaceInstructions(workspaceFile.content)
		: undefined;

	const effectiveFragments = workspaceFragment
		? [...this.#systemPrompts, workspaceFragment]
		: this.#systemPrompts;

	const systemPrompt = this.#joinSystemPrompts(effectiveFragments);
	const messages = freezeMessages([
		...this.#state.messages,
		...request.promptMessages,
	]);

	request.signal.throwIfAborted();

	// 从这里开始只能同步 commit。
	this.#state.messages = messages;
	this.#state.messageIds = messageIds;
	this.#revision++;

	return new RunContext(systemPrompt, request.tools, this.#state);
}
```

`prepareRun` 先执行，`AGENTS.md` 后读取。这样宿主的 prepare hook 如果同步 workspace 文件，当前
Run 能读取同步后的稳定版本。

任何读取、解码、渲染或 join 失败都必须发生在 commit 之前。失败时：

- 本次 prompt messages 不进入 Context history；
- revision 不增加；
- 不创建可见的 run-local Context；
- Agent 恢复为 idle 并暴露分类错误。

### 8.2 Run 内稳定性

`RunContext.systemPrompt` 在构造后不可变。ContextManager 后续只更新它所引用的 message state：

```text
LLM call 1: same systemPrompt + prompt
tool call
LLM call 2: same systemPrompt + prompt + assistant + toolResult
steer/follow-up
LLM call 3: same systemPrompt + expanded messages
```

不得在每次 tool round 前重新读取 `AGENTS.md`。

### 8.3 Snapshot 语义

`ContextManager.snapshot().systemPrompts` 继续表示构造时配置的静态 fragments，不同步读取文件，
避免把同步 snapshot API 变成隐式 I/O。

`ContextSnapshot` 增加 workspace：

```ts
export interface ContextSnapshot {
	readonly workspace?: SessionWorkspace;
	readonly systemPrompts: readonly SystemPrompt[];
	readonly messages: readonly AgentMessage[];
}
```

最新一次有效 `AGENTS.md` 内容不保存在 snapshot 中。需要检查实际发送内容时使用
`llm.call.started` 的 request capture 或 Provider adapter 的 `onPayload` 调试入口。

## 9. Compact 语义

### 9.1 自动 compact

自动 compact 已经接收当前 `AgentContext.systemPrompt`，因此必须直接使用本次 Run 读取到的
workspace fragment，不再次访问文件系统。

压缩完成后只替换 `messages`：

```text
systemPrompt = configured fragments + 本次 Run 的 AGENTS.md fragment
messages     = checkpoint user message + retained recent messages
tools        = 原工具定义
```

### 9.2 手动 compact

`compactCurrent()` 发生在 idle 状态，没有 active Run。它必须调用和 `beginRun()` 相同的
`prepareEffectiveSystemPrompt()` 异步函数，重新读取当前 `AGENTS.md`，然后再启动摘要调用。

手动 compact 继续使用 revision/copy-then-commit 检查。如果读取或摘要期间 Context 被改变，不能
提交过期的 candidate messages。

### 9.3 摘要 prompt

当前内置压缩器会形成：

```text
effective business system prompt

DEFAULT_COMPACTION_PROMPT

additionalSummaryInstructions
```

因此 `AGENTS.md` 也会进入 summary system prompt。它可以帮助摘要器保留 workspace 约束，但也可能
与维护指令冲突。本期保持现有行为；后续应将 business instructions 作为引用数据传给摘要器，给
compaction maintenance prompt 独立的最高层指令。

## 10. Agent Service 接线

### 10.1 workspace 的选择权属于宿主

Agent Service 不应默认允许远程调用方提交任意服务器绝对路径。当前
`resolveSessionOptions(profile, context)` 继续作为 workspace allowlist 边界：

```ts
interface CreateServiceSessionInput {
	readonly agentProfileId: string;
	readonly title?: string;
	readonly workspaceId?: string;
	readonly idempotencyKey: string;
}

interface ResolveSessionOptionsContext {
	readonly ownerId: string;
	readonly sessionId: string;
	readonly workspaceId?: string;
}
```

`workspaceId` 是宿主定义的逻辑标识，不是路径。Agent Service 把它原样交给
`resolveSessionOptions`，但只有 resolver 能把它解析成物理 cwd：

```ts
resolveSessionOptions(profile, serviceContext) {
	const cwd = resolveAllowedWorkspace(
		serviceContext.ownerId,
		serviceContext.workspaceId,
	);

	return {
		model,
		workspace: { cwd },
		contextManagerOptions: {
			systemPrompts: profile.systemPrompts,
		},
		// ...
	};
}
```

如果服务需要让客户端选择 workspace，HTTP 输入应使用宿主管理的 `workspaceId`，再由宿主解析为
cwd；不要直接接受任意 `cwd`。workspace registry 不属于本期 Core 实现。

### 10.2 Service/Runtime 可见性

为保持“Session 有 workspace”这一不变量，建议同时扩展：

```ts
interface ManagedSession {
	readonly workspace: SessionWorkspace;
}

interface ManagedSessionInfo {
	readonly workspace?: SessionWorkspace;
}

interface ServiceSessionInfo {
	readonly workspace?: SessionWorkspace;
}
```

`creating` 状态可能还没有最终 workspace，字段可以省略；`ready` 状态必须存在。若部署环境不应向
客户端暴露物理路径，Service DTO 应改为只返回 `workspaceId`，但 Core `Session.workspace` 仍保留
绝对 cwd。

## 11. Trace 与可观测性

`context.prepared` 至少增加：

```ts
{
	workspaceInstructionsLoaded: boolean;
	workspaceInstructionsBytes?: number;
	workspaceInstructionsSha256?: `sha256:${string}`;
}
```

默认 trace 不记录 `AGENTS.md` 正文。`TRACE_LEVEL=debug` 的 request capture 当前会记录
`systemPrompt`，操作者必须明确知道这会包含 workspace 指令；仍受 `TRACE_MAX_VALUE_BYTES` 限制。

不得把完整 cwd 或 `AGENTS.md` 正文新增到 summary/execution 级 trace。错误事件只记录分类 code、
basename、大小和 hash 等必要元数据。

现有 `systemPromptCount` 应统计有效 fragments，而不只是静态 `snapshot.systemPrompts.length`。
可以给默认 `RunContext` 增加不含正文的内部 metadata，供 TraceRecorder 读取；不要靠重新切分已拼接
字符串推断 fragment 数量。

## 12. 安全边界

`AGENTS.md` 拥有 system-level 权限。这意味着能够写入该文件的人可以改变 Agent 的工具使用方式、
输出要求和代码操作策略。

必须明确：

1. 只有经过宿主认可的 workspace 才能启用该功能。
2. 打开下载的陌生仓库前，宿主应提示或禁用 workspace instructions。
3. 文件内容会发送给模型 Provider，严禁存放秘密。
4. 固定文件名、普通文件检查和大小限制不能防止恶意指令，只能限制读取面和资源消耗。
5. 调用方的基础 system prompts 始终排在前面，并通过桥接文案声明 workspace 指令不能覆盖它们。
6. Tool 层仍必须执行自己的路径权限和参数校验，不能把 system prompt 当成安全边界。

## 13. 验收测试

### 13.1 Workspace

1. 未提供 workspace 时，cwd 是 `Session.create()` 当时 `process.cwd()` 的绝对路径。
2. 相对 cwd 被解析为绝对路径。
3. 空白 cwd 和含 NUL 的 cwd 在任何 factory 执行前失败。
4. workspace 对象被冻结。
5. Session 和全部 factory context 引用同一个 workspace 对象。
6. Session 创建后改变 `process.cwd()` 不影响该 Session。
7. 默认 ContextManager 使用 Session 强制注入的 workspace，调用方不能通过 options 覆盖。

### 13.2 文件读取

8. `AGENTS.md` 不存在时保持原有 system prompt。
9. 空文件和纯空白文件不产生 fragment。
10. UTF-8 BOM 被移除，CRLF 被规范化为 LF。
11. 非法 UTF-8、超限文件、目录、symlink 和权限错误产生正确分类错误。
12. abort 能中止读取，且不会提交 prompt message。
13. Loader 只读取 workspace 根目录的固定文件，不向父目录查找。

### 13.3 System prompt

14. 静态 fragments 保持原顺序。
15. workspace fragment 只出现一次并位于静态 fragments 之后。
16. 未配置静态 fragment 时，非空 `AGENTS.md` 仍产生 system message。
17. `AGENTS.md` 内容不出现在 `context.messages` 或 Transcript。
18. Adapter 仍只发送一个拼接后的 `role: "system"` message。
19. 工具定义仍位于 payload 顶层 `tools`，不混入 prompt。

### 13.4 生命周期

20. 同一 Run 的多轮 tool loop 使用完全相同的 system prompt 和文件 hash。
21. steer 和 follow-up 不触发重复读取。
22. 修改 `AGENTS.md` 后，下一个顶层 prompt 使用新内容。
23. 文件在 Run 中途被修改不影响当前 Run。
24. 自动 compact 使用当前 Run 的 effective system prompt。
25. 手动 compact 重新读取文件，并保持 copy-then-commit 原子性。
26. 读取失败后 Agent 回到 idle，Context history 和 revision 保持不变。

### 13.5 多 Session 隔离

27. 两个不同 cwd 的 Session 分别读取自己的 `AGENTS.md`。
28. 一个 Session 的文件更新不会改变另一个 Session。
29. 并发创建 Session 时不共享 workspace、loader result 或文件缓存。

## 14. 实施文件清单

建议按以下顺序实现：

1. `packages/agent-core/src/types.ts`
   - 增加 workspace 和 loader 类型。
2. `packages/agent-core/src/workspace.ts`
   - 实现 cwd 解析、受限文件读取、规范化和 renderer。
3. `packages/agent-core/src/errors.ts`
   - 增加 `WorkspaceContextError`。
4. `packages/agent-core/src/session.ts`
   - 解析、冻结、保存并向 factories 传递 workspace。
5. `packages/agent-core/src/context-manager.ts`
   - prepare 阶段读取文件并生成 effective system prompt。
   - 让手动 compact 复用同一构造函数。
6. `packages/agent-core/src/session-runtime.ts`
   - 在 managed handle/snapshot 中暴露 workspace。
7. `packages/agent-core/src/trace-recorder.ts` 与 trace types
   - 记录 loaded/bytes/hash，不默认记录正文。
8. `packages/agent-service`
   - 传递宿主 allowlist 后的 workspace，并决定 DTO 是否暴露 cwd。
9. Core、Runtime、Service 和 Adapter 测试
   - 覆盖第 13 节全部不变量。
10. README 和 DeepSeek 示例
   - 展示如何给 Session 指定 workspace。

`packages/chat-completions-adapter/src/request.ts` 不需要改变。它已经会把
`AgentContext.systemPrompt` 放在消息首位，并把 tools 单独发送。

## 15. 最终调用示例

```ts
const session = await Session.create({
	model,
	workspace: {
		cwd: "D:\\ailoha",
	},
	createModelRunner: () => modelRunner,
	contextManagerOptions: {
		systemPrompts: [
			"You are a software engineering agent.",
		],
	},
});

console.log(session.workspace.cwd); // D:\ailoha

await session.agent.prompt("检查项目并给出下一步建议");
```

当 `D:\ailoha\AGENTS.md` 内容为：

```text
Use PowerShell commands in this workspace.
Run focused tests before broader test suites.
```

有效 system prompt 为：

```text
You are a software engineering agent.

Workspace-specific instructions loaded from AGENTS.md follow. They apply to this workspace and may refine, but must not override, earlier system instructions.

Use PowerShell commands in this workspace.
Run focused tests before broader test suites.
```

下一次顶层 `prompt()` 会重新读取 `AGENTS.md`；当前 Run 内的所有模型调用继续使用这份已经生成的
system prompt。
