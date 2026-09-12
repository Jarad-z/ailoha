# Session Runtime Spec

状态：Implemented v0.1  
目标版本：`@ailoha/agent-core` 下一阶段  
术语说明：本文统一使用 **Session Runtime**，下文简称 `Runtime`。

## 1. 背景

当前 `@ailoha/agent-core` 已具备单 Session 生命周期：

```text
Session
└─ Agent
   ├─ ModelRunner
   ├─ ContextManager
   └─ ToolManager
      └─ AgentTool[]
```

一个 Session 内：

- Agent 同一时间只允许一个 active run；
- ContextManager 独占 system prompts 和 message history；
- ToolManager 及其 Tool 实例与 Session 同生命周期；
- `Session.dispose()` 负责停止 active run 并释放 Tool。

目前缺少一个进程级组件来创建、索引、查询和销毁多个 Session。调用方如果自行维护 `Map<string, Session>`，很容易在重复 ID、并发创建、Runtime 关闭、部分初始化失败和批量释放等场景中产生竞态或资源泄漏。

## 2. 目标

新增 `SessionRuntime`，作为多个 Session 的唯一生命周期所有者，并满足：

1. 一个 Runtime 可以管理多个 Session。
2. 不同 Session 可以同时运行，互不阻塞。
3. 同一 Session 内仍保持“一次最多一个 active run”的现有语义。
4. 每个 Session 拥有独立的 Agent、ContextManager、ToolManager、Tool 实例、消息队列和取消信号。
5. 一个 Session 的 prompt、steer、follow-up、compact、Tool 状态、错误或取消不能进入另一个 Session。
6. Session ID 在 Runtime 内唯一，并在并发创建开始时立即预留。
7. 单个 Session 创建或运行失败不影响其他 Session。
8. Runtime 关闭时停止接收新 Session，取消未完成的创建，并释放所有已创建 Session。
9. 所有 dispose 操作幂等；批量释放即使部分失败，也必须继续释放剩余资源。
10. API 对并发和生命周期竞态给出确定语义，调用方不需要自己维护锁。

## 3. 非目标

MVP 不实现：

- 一个 Session 内并发执行多个顶层 `prompt()`；
- 多 Agent 共享同一段对话上下文；
- Tool call 并行执行策略；
- 跨进程、跨机器或 Worker Thread 调度；
- Session 持久化、进程重启恢复或分布式注册表；
- LLM 请求的全局排队、限流、优先级或公平调度；
- 文件系统、网络、操作系统进程或凭证级安全沙箱；
- 不可信 Tool 代码的安全隔离；
- Runtime 级事件总线、审计日志或指标系统；
- Session 迁移、克隆、fork 或热更新 Tool；
- 自动重试 Session 创建、模型请求或 Tool 执行。

“Tool 隔离”在本 Spec 中指对象实例、内存状态、生命周期和执行上下文隔离，不代表操作系统安全边界。Tool 访问同一个数据库、目录或远端账号时，外部副作用仍可能共享；需要由 Tool 配置使用 session namespace、独立凭证或独立工作目录解决。

## 4. 核心对象与所有权

```text
SessionRuntime
├─ Runtime AbortController
├─ Session registry: Map<SessionId, SessionRecord>
├─ Session A
│  ├─ Agent A
│  ├─ ContextManager A
│  ├─ ToolManager A
│  └─ Tool instances A
├─ Session B
│  ├─ Agent B
│  ├─ ContextManager B
│  ├─ ToolManager B
│  └─ Tool instances B
└─ Session C ...
```

所有权规则：

```text
Session 注册表、Session ID、批量关闭       → SessionRuntime
单个 Session 的创建和销毁                 → SessionRuntime
单个 Agent 的 run、队列和 run signal       → Agent
单个 Session 的 prompts/messages/compact  → 该 Session 的 ContextManager
单个 Session 的 Tool 注册、实例和释放       → 该 Session 的 ToolManager
```

硬约束：

- Runtime 不保存或拼接任何 Session 的消息。
- Runtime 不执行 Agent 的 ReAct loop。
- Session 之间不得共享 ContextManager、ToolManager 或 AgentTool 对象实例。
- Runtime 可以共享不可变配置、Model 描述、无状态 provider client 或 Tool factory 定义，但 factory 每次必须为目标 Session 产生独立 Tool 实例。
- Runtime 只协调生命周期，不成为全局可变上下文容器。

## 5. 公开类型与 API

### 5.1 标识和状态

```ts
export type SessionId = string;

export type SessionRuntimeStatus =
	| "open"
	| "disposing"
	| "disposed";

export type ManagedSessionStatus =
	| "creating"
	| "ready"
	| "disposing"
	| "disposed";
```

失败的 Session 不长期保留 `failed` 状态：创建 Promise reject 后，Runtime 删除对应预留记录，调用方可以使用同一个 ID 再次创建。错误通过 reject 返回；长期错误历史不属于 MVP。

### 5.2 创建参数

```ts
export interface CreateManagedSessionOptions {
	/** 省略时由 Runtime 生成；不得为空。 */
	readonly id?: SessionId;

	/** 传给现有 Session.create() 的配置。 */
	readonly session: SessionOptions;

	/** 只取消本次创建；创建成功后不再影响 Session。 */
	readonly signal?: AbortSignal;
}

export interface SessionRuntimeOptions {
	/** 默认使用 crypto.randomUUID()。 */
	readonly generateSessionId?: () => SessionId;

	/** Runtime 中 creating + ready + disposing 的最大记录数；默认 Infinity。 */
	readonly maxSessions?: number;

	/** 测试或定制构造使用；默认调用 Session.create()。 */
	readonly createSession?: (
		options: SessionOptions,
		context: SessionCreationContext,
	) => Promise<Session>;
}

export interface SessionCreationContext {
	readonly id: SessionId;
	readonly signal: AbortSignal;
}
```

`SessionCreationContext.signal` 只覆盖创建阶段。Session 创建成功后，Runtime 必须解除该 signal 与 Session lifetime signal 的关联；调用方事后 abort 创建 signal 不得销毁一个已经 ready 的 Session。

### 5.3 Handle 与只读信息

```ts
export interface ManagedSessionInfo {
	readonly id: SessionId;
	readonly status: ManagedSessionStatus;
	readonly createdAt: number;
	readonly readyAt?: number;
	readonly agentStatus?: AgentStatus;
}

export interface ManagedSession {
	readonly id: SessionId;
	readonly agent: Agent;
	readonly createdAt: number;
	readonly readyAt: number;

	/** 委托给所属 Runtime；幂等。 */
	dispose(): Promise<void>;

	/** 返回当前只读信息，不暴露内部 record。 */
	snapshot(): ManagedSessionInfo;
}
```

Handle 不直接暴露 ContextManager、ToolManager 或可变的 SessionRecord，防止调用方绕过隔离和生命周期管理。`agent` 保留现有 prompt/steer/follow-up/abort API。

### 5.4 Runtime API

```ts
export class SessionRuntime {
	readonly status: SessionRuntimeStatus;

	constructor(options?: SessionRuntimeOptions);

	createSession(
		options: CreateManagedSessionOptions,
	): Promise<ManagedSession>;

	getSession(id: SessionId): ManagedSession | undefined;

	listSessions(): readonly ManagedSessionInfo[];

	disposeSession(id: SessionId): Promise<boolean>;

	dispose(): Promise<void>;
}
```

返回语义：

- `createSession()` 只在 Session 完全 ready 后 resolve。
- `getSession()` 只返回 `ready` 的 Handle；`creating` 和 `disposing` 返回 `undefined`。
- `listSessions()` 返回调用瞬间的冻结快照，可以看到 `creating`、`ready` 和 `disposing`。
- `disposeSession()` 找到目标时返回 `true`；目标不存在或已被清理时返回 `false`。
- `ManagedSession.dispose()` 与 `runtime.disposeSession(id)` 使用同一个底层 Promise。
- Runtime `disposing` 或 `disposed` 后，`createSession()` 必须同步返回 rejected Promise，不得调用任何 Session factory。

## 6. Runtime 状态机

```text
open
  ├─ createSession / getSession / listSessions / disposeSession
  └─ dispose()
       ↓
disposing
  ├─ reject new createSession
  ├─ abort all pending creations
  ├─ dispose all ready Sessions concurrently
  └─ wait for every cleanup to settle
       ↓
disposed
```

约束：

- `dispose()` 第一次调用时同步把状态切为 `disposing`。
- `dispose()` 必须缓存并始终返回同一个 Promise。
- `disposing` 期间允许 `listSessions()`，用于观察关闭过程。
- `disposed` 后注册表为空。
- Runtime 关闭不允许被撤销或重新打开。

## 7. Session Record 状态机

每个 ID 对应一个私有 record：

```ts
interface SessionRecord {
	readonly id: SessionId;
	readonly createdAt: number;
	readonly createController: AbortController;
	status: ManagedSessionStatus;
	session?: Session;
	handle?: ManagedSession;
	readyAt?: number;
	createPromise: Promise<ManagedSession>;
	disposePromise?: Promise<void>;
}
```

正常路径：

```text
ID absent
  └─ reserve ID synchronously → creating
       ├─ Session.create succeeds → ready
       └─ Session.create fails    → remove record

ready
  └─ disposeSession() → disposing
       ├─ Session.dispose succeeds → disposed → remove record
       └─ Session.dispose fails    → disposed → remove record → reject
```

创建中关闭：

```text
creating
  └─ disposeSession() / Runtime.dispose()
       ├─ mark disposing
       ├─ abort createController
       ├─ await createPromise settlement
       ├─ if a Session was produced by a cancellation-ignoring factory,
       │    dispose it immediately and never publish a ready Handle
       └─ remove record
```

`disposed` 是清理过程中的瞬时状态；record 最终从注册表删除，不作为 tombstone 长期保存。

## 8. 创建流程与原子性

`createSession()` 必须遵循以下顺序：

```text
1. validate Runtime status
2. validate/generate non-empty Session ID
3. validate capacity
4. atomically reserve ID in registry as creating
5. create a per-creation AbortController
6. compose caller creation signal + Runtime shutdown signal
7. call Session factory
8. check creation signal again
9. publish Session and stable Handle in one synchronous commit
10. resolve Handle
```

伪代码：

```ts
createSession(options: CreateManagedSessionOptions): Promise<ManagedSession> {
	if (this.#status !== "open") {
		return Promise.reject(new SessionRuntimeStateError("Runtime is not open."));
	}

	const id = validateId(options.id ?? this.#generateSessionId());
	if (this.#records.has(id)) {
		return Promise.reject(new DuplicateSessionIdError(id));
	}
	if (this.#records.size >= this.#maxSessions) {
		return Promise.reject(new SessionCapacityError(this.#maxSessions));
	}

	// 在第一次 await 前预留，避免两个并发调用都通过检查。
	const record = this.#reserve(id, options.signal);
	record.createPromise = this.#finishCreate(record, options.session);
	return record.createPromise;
}
```

创建不变量：

- 重复 ID 检查和 ID 预留之间不能有 `await`。
- 达到容量上限时不能调用 factory。
- factory 抛错、取消或创建后校验失败时，必须释放所有已创建资源并删除预留记录。
- 如果 Runtime 在 factory resolve 前进入 `disposing`，新 Session 不得短暂发布为 `ready`。
- `createSession()` reject 后，`getSession(id)` 必须返回 `undefined`。

### 8.1 对现有 Session.create 的最小改动

为使 Runtime 能取消卡在异步 Tool factory 中的 Session 创建，现有 API 增加创建阶段 signal：

```ts
export interface SessionCreateOptions {
	/** Runtime 管理时传入预留 ID；独立创建时省略并自动生成。 */
	readonly id?: SessionId;

	readonly signal?: AbortSignal;
}

class Session {
	readonly sessionId: SessionId;

	static create(
		options: SessionOptions,
		createOptions?: SessionCreateOptions,
	): Promise<Session>;
}
```

实现要求：

- 创建期间，`createOptions.signal` 临时转发到 Session lifetime controller。
- `SessionFactoryContext.sessionId`、`ToolInitContext.sessionId` 和最终 `Session.sessionId` 必须使用 `createOptions.id`；省略时只生成一次，并在整个 Session 生命周期中保持稳定。
- Runtime 必须验证 factory 返回的 `Session.sessionId === record.id`，不匹配时创建失败并释放这个尚未发布的 Session。
- 创建成功 commit 前再次检查 signal。
- 创建成功后移除转发 listener；随后调用方 abort `createOptions.signal` 不影响 ready Session。
- 创建失败时按现有逆序规则释放已初始化 Tool。
- Runtime 默认 factory 调用 `Session.create(options, { id: context.id, signal: context.signal })`。

## 9. 隔离模型

### 9.1 必须隔离的状态

| 状态/资源 | Session 间是否可共享 | 规则 |
|---|---:|---|
| Agent | 否 | 每个 Session 一个新实例 |
| ContextManager | 否 | system prompts、messages、compact 状态独立 |
| ToolManager | 否 | 注册表、状态机、dispose 独立 |
| AgentTool 实例 | 否 | factory 每个 Session 分别调用并返回新实例 |
| steer/follow-up queue | 否 | 由各自 Agent 私有持有 |
| active run controller | 否 | 每个 prompt 独立 |
| Session lifetime controller | 否 | 每个 Session 独立 |
| creation controller | 否 | 每个 record 独立 |
| AgentModel 描述 | 是 | 视为不可变配置 |
| Tool factory 函数定义 | 是 | factory 本身可复用，产物不可复用 |
| 无状态 provider transport | 可选 | 不得保存 Session messages 或 Tool 状态 |

### 9.2 Context 隔离

必须保证：

- Session A 的 prompt 只提交到 ContextManager A。
- Session A 的 `snapshot()` 永远不能出现 Session B 的消息。
- A 的 compact 不能替换 B 的 history。
- A 的 system prompts 不进入 B 的 model request。
- 两个 Session 即使使用相同 Model 和相同 prompt 文本，也生成两份独立 history。
- 不允许通过模块级数组、静态字段或 Runtime 全局变量保存“当前消息”。

### 9.3 Tool 隔离

必须保证：

- 每个 Session 创建自己的 ToolManager。
- 每个 Tool factory 对每个 Session 调用一次。
- 同名 Tool 在不同 Session 中允许存在，但对象实例必须不同。
- Tool 的可变内存状态只在所属 Session 的多次 prompt 之间复用。
- dispose Session A 只调用 A 的 Tool disposer，不能释放或改变 B 的 Tool。
- `ToolExecutionContext` 增加稳定的 `sessionId`，供 Tool 构造 namespace、日志字段或工作目录：

```ts
export interface ToolInitContext {
	readonly sessionId: SessionId;
	readonly model: AgentModel;
	readonly signal: AbortSignal; // Session lifetime
}

export interface ToolExecutionContext {
	readonly sessionId: SessionId;
	readonly model: AgentModel;
	readonly context: AgentContext;
	readonly signal: AbortSignal; // current run
}
```

`SessionFactoryContext` 同样增加 `sessionId`。独立使用 `Session.create()` 且没有 Runtime 时，由 Session 自己生成 ID，保证这两个上下文仍有稳定标识。

自定义 `createContextManager`、`createToolManager` 和 Tool factory 必须遵守“每次 Session 创建返回新实例”的契约。开发模式可用对象 identity 检查尽早报错，但 Runtime 无法检测 Tool 闭包内部偷偷共享的外部状态。

自定义 Runtime `createSession` factory 也不得为两个 ID 返回同一个 `Session` 对象。Runtime 必须用 `WeakMap<Session, SessionId>` 检测其直接拥有的 Session identity；发现重复所有权时，新创建路径失败且不能释放仍由原 record 使用的 Session。

## 10. 并发语义

MVP 使用 JavaScript 单进程异步并发，不承诺 CPU 并行。

### 10.1 不同 Session

以下操作可以重叠执行：

```ts
const [a, b] = await Promise.all([
	runtime.createSession({ id: "a", session: optionsA }),
	runtime.createSession({ id: "b", session: optionsB }),
]);

const [resultA, resultB] = await Promise.all([
	a.agent.prompt("task A"),
	b.agent.prompt("task B"),
]);
```

Runtime 不持有覆盖 LLM 或 Tool 执行过程的全局锁。Session A 等待模型、Tool 或 compact 时，Session B 可以继续推进。

### 10.2 同一 Session

维持现有 Agent 规则：

- 一个 Agent 同时最多一个 active run。
- 第二个并发 `prompt()` reject `AgentStateError`，Runtime 不自动排队。
- `steer()` 和 `followUp()` 只作用于该 Session 的 active run。
- 调用方需要排队时，应在 Runtime 外实现，或作为未来显式 scheduler 功能加入。

### 10.3 资源限制

`maxSessions` 只限制 Runtime 持有的 Session record 数量，不限制同时 active 的 Agent run 数量。MVP 不提供全局并发 semaphore，避免 Handle 直接暴露 `agent.prompt()` 时出现可绕过的“伪限制”。

## 11. 销毁、取消与竞态

### 11.1 销毁单个 Session

`disposeSession(id)`：

1. 同步把 record 从 `ready/creating` 切为 `disposing`。
2. 从这一刻起 `getSession(id)` 返回 `undefined`。
3. 如果正在创建，abort creation signal，并等待创建路径完成清理。
4. 如果已经 ready，立即调用 `Session.dispose()`，使 Agent 同步停止接收 prompt。
5. 等待 active run 结束和全部 Tool disposer 执行。
6. 无论成功或失败都把 record 标记为 `disposed` 并从 Map 删除。
7. 如果清理失败，reject 原始或聚合错误。

同一 ID 的并发 `disposeSession()` 和 `ManagedSession.dispose()` 必须共享一个 dispose Promise，不得重复调用底层 disposer。

### 11.2 销毁 Runtime

Runtime `dispose()` 使用快照捕获当前所有 record，然后并发清理：

```ts
const results = await Promise.allSettled(
	records.map((record) => this.#disposeRecord(record)),
);
```

规则：

- 必须先同步切换 Runtime 状态，再开始任何 await。
- 一个 Session dispose 失败不能阻止其他 Session dispose。
- 全部 settle 后清空 registry 并切换到 `disposed`。
- 无错误则 resolve；有错误则以 `AggregateError` reject，errors 按 Session ID 排序，保证测试和日志稳定。
- 即使 Promise reject，Runtime 状态仍然必须是 `disposed`。

### 11.3 关键竞态的确定结果

| 竞态 | 结果 |
|---|---|
| 两次同时 create 同一 ID | 一个预留成功，另一个立即 reject duplicate ID |
| create 不同 ID | 可以并发初始化 |
| create 期间 disposeSession | 创建被取消；即使 factory 忽略 signal 并返回，也立即释放且不发布 |
| create 期间 Runtime.dispose | 与上相同，且 Runtime 等待创建清理完成 |
| prompt 期间 disposeSession | active run abort，等待 Agent idle，再释放该 Session Tool |
| Session A dispose 与 Session B prompt | B 不受影响并可正常完成 |
| disposeSession 完成后立刻复用 ID | 允许；旧 record 已移除，新 Session 是全新生命周期 |
| Runtime.dispose 与新 create 同 tick | 先同步完成状态/ID 预留的调用获胜；dispose 仍会清理它，之后的 create reject |

## 12. 错误类型

新增错误：

```ts
class SessionRuntimeStateError extends Error {}
class InvalidSessionIdError extends Error {}
class DuplicateSessionIdError extends Error {
	readonly sessionId: SessionId;
}
class SessionCapacityError extends Error {
	readonly maxSessions: number;
}
```

错误隔离规则：

- Session A 创建失败只 reject A 的 `createSession()`。
- Session A run 失败只更新 Agent A 的 `lastError`。
- Session A Tool dispose 失败只影响 A 的 dispose Promise；Runtime 批量关闭时收集该错误。
- Runtime 不设置全局 `lastError`，避免多个并发错误互相覆盖。
- 错误消息不得包含其他 Session 的 prompt、history、Tool result 或 secret。

## 13. 快照与可观察性

`listSessions()`：

- 返回冻结的新数组和冻结的信息对象；
- 不返回消息内容、system prompt、Tool options 或 credentials；
- 默认按 `createdAt` 升序、相同时间按 ID 字典序排序；
- `agentStatus` 只在 Session `ready` 时存在；
- 读取复杂度允许为 O(n)，不得阻塞任何 Session run。

示例：

```ts
[
	{
		id: "support-42",
		status: "ready",
		createdAt: 1789196400000,
		readyAt: 1789196400120,
		agentStatus: "running",
	},
]
```

## 14. 安全与数据边界

- Session ID 仅作逻辑标识，不直接拼接为文件路径、SQL、URL 或 shell 参数。
- 若 Tool 需要磁盘目录，必须先经过合法化并验证解析后的目录位于允许的 session root 内。
- Tool 日志应携带 `sessionId`，但不得默认记录完整 prompt、Tool 参数或结果。
- Context snapshot 只能由持有该 Session Handle 的调用方通过 Agent Core 明确能力读取；Runtime 的列表接口不得返回上下文内容。
- 共享 HTTP client 或连接池时，不得在 client 全局默认 header、cookie jar 或 mutable metadata 中保存 session-specific 凭证。
- 本 Runtime 是逻辑隔离，不适合直接运行不可信代码；强安全隔离需要独立进程/容器方案。

## 15. 示例

```ts
const runtime = new SessionRuntime({ maxSessions: 100 });

const create = (id: string, systemPrompt: string) =>
	runtime.createSession({
		id,
		session: {
			model,
			createModelRunner: () => createModelRunner(client),
			contextManagerOptions: { systemPrompts: [systemPrompt] },
			configureTools(manager) {
				manager.register("todo", (_request, context) =>
					createTodoTool({ namespace: context.sessionId }),
				);
			},
			toolRequests: [{ name: "todo" }],
		},
	});

const [alice, bob] = await Promise.all([
	create("alice", "You assist Alice."),
	create("bob", "You assist Bob."),
]);

const [aliceResult, bobResult] = await Promise.all([
	alice.agent.prompt("Remember: project red"),
	bob.agent.prompt("Remember: project blue"),
]);

await alice.dispose(); // Bob remains ready and usable.
await runtime.dispose();
```

## 16. 必须保持的运行不变量

1. 一个 Runtime 中任意时刻最多存在一个给定 ID 的 record。
2. duplicate check 与 record reservation 之间没有 await。
3. `getSession()` 永远不返回半初始化或正在销毁的 Session。
4. 一个 Session 的 Agent、ContextManager、ToolManager 和 Tool 实例不与其他 Session 共用。
5. 一个 Session 的消息只能进入自己的 ContextManager。
6. 一个 Session 的 Tool call 只能由自己的 Tool 实例执行。
7. 单个 Session 的失败、取消和 dispose 不改变其他 Session 的状态。
8. 同一 Session 仍然最多只有一个 active run。
9. 不同 Session 的 active run 之间不存在 Runtime 全局互斥锁。
10. 每个 ready Session 最终恰好执行一次底层 `Session.dispose()`。
11. Runtime dispose 会等待所有 creating/ready/disposing record 完成清理。
12. Runtime dispose 部分失败时仍释放所有其他 Session。
13. Runtime 最终进入 `disposed`，且 registry 为空。
14. 创建取消后产生的迟到 Session 不得发布，必须立即 dispose。
15. Session ID 不得隐式成为安全边界或未经校验的资源路径。

## 17. MVP 验收测试

至少覆盖：

1. 创建一个 Session，`getSession()` 返回同一个稳定 Handle。
2. 自动生成的两个 ID 非空且不同。
3. 并发创建相同 ID：factory 只调用一次，另一个调用以 `DuplicateSessionIdError` reject。
4. 并发创建不同 ID：两个 factory 在任一 factory 完成前都已开始。
5. `maxSessions` 计入 creating record；超限时不调用 factory。
6. 创建失败后删除预留 record，同一 ID 可以重试。
7. `getSession()` 不返回 creating Session。
8. `listSessions()` 能看到 creating、ready、disposing 的准确状态。
9. `listSessions()` 返回冻结快照，修改快照不影响 Runtime。
10. Session A 和 B 可通过 `Promise.all()` 同时运行 prompt。
11. A 的模型等待期间 B 可以完成模型和 Tool 循环。
12. 同一 Session 并发第二次 prompt 仍以 `AgentStateError` reject。
13. A/B 使用不同 ContextManager 实例，消息历史互不出现。
14. A/B 同名 Tool 的 factory 分别调用一次，Tool 对象 identity 不同。
15. A 的有状态 Tool 跨 A 的多次 prompt 保持状态，但 B 看不到该状态。
16. A compact 后 B 的 context history 不变。
17. A steer/follow-up 不进入 B 的队列或 history。
18. A abort 或模型失败不改变 B 的 `AgentState`。
19. dispose A 会 abort A 的 active run并只释放 A 的 Tool；B 仍可 prompt。
20. 多次 dispose A 共享同一个 Promise，Tool disposer 只调用一次。
21. 创建中 dispose A 会 abort factory，删除 record，并且不发布 Handle。
22. factory 忽略 creation signal 并迟到返回 Session 时，Runtime 立即 dispose 该 Session。
23. Runtime dispose 同步拒绝之后的新 create。
24. Runtime dispose 并发释放全部 Session，而不是逐个串行等待。
25. 一个 Session disposer 抛错时，其他 Session 仍被释放，最终抛出 `AggregateError`。
26. Runtime dispose 成功、失败和重复调用后，最终状态均为 `disposed`，registry 为空。
27. Runtime dispose 与 create 竞态符合第 11.3 节定义，不产生泄漏或 ready 窗口。
28. dispose 完成后可以在仍为 open 的 Runtime 中复用同一 Session ID，且所有上下文和 Tool 状态从空白开始。
29. `ToolInitContext.sessionId` 与 `ToolExecutionContext.sessionId` 始终等于所属 record ID。
30. Runtime 列表和错误信息不泄露 prompt、history、Tool 参数或其他 Session 数据。
31. 自定义 Runtime factory 返回错误 `sessionId` 时，创建失败且迟到 Session 被释放。
32. 自定义 Runtime factory 为两个 ID 返回同一个 Session 对象时，第二次创建失败，且第一个 Session 保持可用、不会被误释放。

## 18. 实施顺序

建议按以下顺序实现，每一步都保持测试可运行：

1. 为 Session 增加稳定 `sessionId`，并把它传入 factory、Tool init 和 Tool execution context。
2. 为 `Session.create()` 增加只覆盖创建阶段的外部 signal，并补齐迟到结果清理测试。
3. 实现 `SessionRuntime` registry、ID 预留、Handle 和只读 snapshot。
4. 实现单 Session dispose 的并发幂等和 record 清理。
5. 实现 Runtime 批量 dispose、`Promise.allSettled()` 和稳定 `AggregateError`。
6. 增加双 Session 并发与 Context/Tool 隔离测试。
7. 更新 `packages/agent-core/README.md` 和 package exports。

## 19. 完成定义

满足以下条件才视为 Session Runtime MVP 完成：

- 第 17 节验收测试全部通过；
- 现有单 Session、Agent、Tool lifecycle 测试无回归；
- TypeScript 类型检查和 workspace test 全部通过；
- README 提供创建、并发运行、单独销毁和 Runtime 批量关闭示例；
- 没有模块级“当前 Session”“当前 Context”或共享 Tool 实例；
- Runtime 关闭和所有失败路径均不存在未释放的 Session 或 Tool。

## 20. 实施记录

完成日期：2026-09-12

- `SessionRuntime`、Managed Session Handle、Runtime/Session 状态机和错误类型已实现。
- Session ID 已贯穿 Session factory、Agent、Tool 初始化和 Tool 执行上下文。
- ContextManager、ToolManager 和 AgentTool 对象增加跨 Session identity 所有权保护。
- 创建阶段 signal、迟到 factory 结果清理、单 Session dispose 和 Runtime 并发批量 dispose 已实现。
- 新增 Session Runtime 单元测试，并保留现有 Agent、Session、ToolManager 和内置 Tool 回归测试。
- TypeScript check、两个 workspace build 和全部 94 个测试通过。
- DeepSeek 双 Session 真实并发 smoke test 通过：上下文隔离、Todo Tool 状态隔离和批量释放均正常。
