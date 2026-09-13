# Agent Service Runtime Spec

状态：Implemented v0.1  
适用范围：`@ailoha/agent-core` 上层的单进程 Web 后端  
建议包名：`@ailoha/agent-service`

实现位置：

- Core 手动压缩：`packages/agent-core/src/agent.ts`、`context-manager.ts`；
- 协议无关 Service Runtime：`packages/agent-service/src/agent-service-runtime.ts`；
- 内存 Profile、Transcript 与 Event adapter：`packages/agent-service/src/`；
- Node HTTP/SSE adapter：`packages/agent-service/src/http.ts`；
- 验收测试：`packages/agent-core/test/manual-compact.test.ts`、`packages/agent-service/test/`。

v0.1 按本文 MVP 约束使用单进程内存状态；第 15.2、Phase 4 的持久化和生产加固仍是后续版本范围。

## 1. 背景

当前 Core 已有以下对象关系：

```text
SessionRuntime
└─ Session[]
   └─ Agent
      ├─ ModelRunner
      ├─ ContextManager
      └─ ToolManager
```

现有能力包括：

- 一个 `SessionRuntime` 管理多个隔离的 Session；
- 不同 Session 可以并发运行；
- 一个 Session 固定拥有一个 Agent；
- 同一 Agent 同时最多运行一个顶层 `prompt()`；
- Agent 已有 run-local 的 steer queue 和 follow-up queue；
- `abort()` 取消当前 run，`disposeSession()` 销毁整个 Session。

Core API 是进程内对象 API，不能直接作为 Web API 使用。浏览器不应该接触 `Agent`、`SessionOptions`、Tool factory、Provider client 或密钥。需要增加一层协议无关的应用服务，把外部请求转换为确定的 Session 和 Agent 操作。

本文定义 `AgentServiceRuntime`，简称 `Service Runtime`。

## 2. 核心决策

### 2.1 Session 是产品里的聊天窗口

一个 Session 对应一个聊天窗口和一个 Agent 实例。创建 Session 时选择 `AgentProfile`，由服务端把 Profile 转换为 `SessionOptions` 并创建真正的 Agent。

MVP 不提供脱离 Session 独立存在的 Agent 实例，也不允许一个 Session 同时拥有多个 Agent。

### 2.2 不重复实现 Agent 消息队列

Service Runtime 不增加第二套 steer/follow-up queue：

- `steer` 直接使用 `agent.steer()`；
- `follow_up` 直接使用 `agent.followUp()`；
- Agent 空闲时使用 `agent.prompt()`；
- admission 不成立时返回确定错误，不在服务层偷偷改变消息类型。

MVP 不承诺“消息一定排队到下一个 run”。如果消息到达时 run 已进入 closing，服务返回 `409 Conflict`，客户端可以刷新状态后重试。

未来如果产品要求离线投递、可靠重试或跨 run backlog，再单独增加持久化 Inbox；它不属于本 Spec。

### 2.3 普通消息不是新的 Core 消息类型

`normal` 或 `auto` 只是 Web 产品的路由策略，不是 Agent Core API：

```text
Agent idle    + auto → prompt
Agent running + auto → followUp
```

改变当前任务方向必须显式选择 `steer`。

### 2.4 abort 与 close 必须分开

```text
abortRun(sessionId, runId)
  → agent.abort()
  → 只取消当前 run
  → Session、上下文和 Tool 仍可继续使用

closeSession(sessionId)
  → sessionRuntime.disposeSession(sessionId)
  → 取消当前工作并永久释放 Session 和 Tool
```

### 2.5 手动压缩是独占维护操作

手动压缩只压缩 Agent Context，不修改产品 Transcript。它与 `prompt()` 互斥，只允许 Agent 空闲时开始。

MVP 在 Agent 正在 running 或 compacting 时拒绝手动压缩，不自动排队，也不自动 abort 当前 run。

## 3. 目标

1. 为浏览器、CLI 或其他进程提供稳定的应用层 Operation。
2. 隐藏不可序列化的 Core 对象和服务端密钥。
3. 使用 Session ID 定位一个聊天窗口及其 Agent。
4. 为每次顶层 Agent 执行分配稳定的 `runId`。
5. 为每次外部写操作分配 `operationId`，支持幂等和状态查询。
6. 把普通消息、steer 和 follow-up 映射到现有 Agent admission 语义。
7. 支持取消当前 run、关闭 Session 和手动压缩 Session Context。
8. 提供 HTTP 命令、状态查询和 SSE 事件流。
9. 一个 Session 的操作失败不得影响其他 Session。
10. 保持 Service Runtime 与具体 HTTP 框架、数据库和 UI 解耦。

## 4. 非目标

MVP 不实现：

- 一个 Session 内并发执行多个顶层 run；
- 多 Agent 编排或 Agent handoff；
- 服务层重复的 steer/follow-up queue；
- 消息跨 run 自动排队；
- Session 跨进程迁移；
- 多副本分布式 Session 调度；
- 进程重启后的 Session 自动恢复；
- 任意用户上传或执行 Tool 代码；
- Tool 的操作系统级安全沙箱；
- token streaming；
- 手动压缩过程中同时接收 prompt、steer 或 follow-up；
- 通过手动压缩重置 Agent turn limit。

## 5. 资源模型

### 5.1 AgentProfile

`AgentProfile` 是可持久化、可序列化的 Agent 配置，不是 Agent 实例。

```ts
export interface AgentProfile {
	readonly id: string;
	readonly name: string;
	readonly modelId: string;
	readonly systemPrompts: readonly string[];
	readonly tools: readonly ToolRequest[];
	readonly maxTurns?: number;
	readonly createdAt: number;
	readonly updatedAt: number;
}
```

Provider client、`createModelRunner`、Tool factory 和凭证只存在于服务端。Profile 中的 `modelId` 和 Tool name 必须通过服务端 allowlist 解析。

### 5.2 ServiceSession

```ts
export type ServiceSessionStatus =
	| "creating"
	| "ready"
	| "closing"
	| "closed";

export interface ServiceSessionInfo {
	readonly id: string;
	readonly ownerId: string;
	readonly agentProfileId: string;
	readonly title?: string;
	readonly status: ServiceSessionStatus;
	readonly agentStatus?: "idle" | "running" | "compacting";
	readonly activeRunId?: string;
	readonly activeOperationId?: string;
	readonly createdAt: number;
	readonly updatedAt: number;
}
```

`ownerId` 必须从认证上下文取得，不能信任请求正文中的任意用户 ID。

### 5.3 Message

产品 Transcript 与模型 Context 是两份不同用途的数据：

```text
Product Transcript
  → 用户在 UI 中看到的不可变消息记录
  → 不因 compact 被删除或改写

Agent Context
  → ContextManager 提供给模型的工作上下文
  → 可以摘要、截断和替换
```

```ts
export interface ServiceMessage {
	readonly id: string;
	readonly sessionId: string;
	readonly runId: string;
	readonly role: "user" | "assistant";
	readonly content: unknown;
	readonly delivery?: MessageDelivery;
	readonly createdAt: number;
}
```

Tool messages和内部摘要默认不进入产品 Transcript；它们通过 Trace/Event API 展示。

### 5.4 Run

每次真正调用 `agent.prompt()` 都创建一个新 Run：

```ts
export type RunStatus =
	| "running"
	| "succeeded"
	| "failed"
	| "aborted";

export interface RunInfo {
	readonly id: string;
	readonly sessionId: string;
	readonly status: RunStatus;
	readonly startedAt: number;
	readonly finishedAt?: number;
	readonly error?: ServiceError;
}
```

steer 和 follow-up 加入当前 Run，不创建新的 `runId`。

### 5.5 Operation

Operation 表示一次外部写命令。Run 是 Agent 执行生命周期；二者不能混为一谈。

```ts
export type OperationType =
	| "session.create"
	| "message.send"
	| "run.abort"
	| "session.compact"
	| "session.close";

export type OperationStatus =
	| "accepted"
	| "running"
	| "succeeded"
	| "failed"
	| "aborted";

export interface OperationInfo {
	readonly id: string;
	readonly type: OperationType;
	readonly sessionId?: string;
	readonly runId?: string;
	readonly status: OperationStatus;
	readonly createdAt: number;
	readonly finishedAt?: number;
	readonly result?: unknown;
	readonly error?: ServiceError;
}
```

对于 steer 和 follow-up，Operation 在 Agent 同步接收消息后即可标记 `succeeded`；它们所属 Run 仍可能继续运行或最终失败。

## 6. Service Runtime 结构

```text
HTTP / SSE Adapter
        │
        ▼
AgentServiceRuntime
├─ AgentProfileRegistry
├─ ServiceSession registry
├─ Run registry
├─ Operation registry
├─ TranscriptStore
├─ EventPublisher
└─ SessionRuntime
   └─ Session
      └─ Agent
```

建议模块拆分：

```text
packages/agent-core
  Agent / Session / SessionRuntime / ContextManager

packages/agent-service
  AgentServiceRuntime
  AgentProfileRegistry
  RunStore / OperationStore / TranscriptStore
  Service events and errors

apps/agent-server
  HTTP routes
  authentication and authorization
  SSE transport
  persistence adapters
```

`AgentServiceRuntime` 不导入任何 HTTP Request/Response 类型。

## 7. 对外 Operation

### 7.1 AgentProfile Operations

```ts
createAgentProfile(input: CreateAgentProfileInput): Promise<AgentProfile>;
getAgentProfile(id: string): Promise<AgentProfile | undefined>;
listAgentProfiles(): Promise<readonly AgentProfile[]>;
updateAgentProfile(id: string, patch: UpdateAgentProfileInput): Promise<AgentProfile>;
deleteAgentProfile(id: string): Promise<boolean>;
```

更新 Profile 不热更新已存在的 Session。新配置只对之后创建的 Session 生效。

### 7.2 Session Operations

```ts
createSession(input: CreateServiceSessionInput): Promise<ServiceSessionInfo>;
getSession(sessionId: string): Promise<ServiceSessionInfo | undefined>;
listSessions(ownerId: string): Promise<readonly ServiceSessionInfo[]>;
updateSession(sessionId: string, patch: { title?: string }): Promise<ServiceSessionInfo>;
closeSession(sessionId: string): Promise<void>;
```

创建流程：

```text
1. authenticate owner
2. validate AgentProfile
3. reserve service Session record
4. resolve server-side SessionOptions
5. call SessionRuntime.createSession()
6. publish session.ready
7. return ServiceSessionInfo
```

### 7.3 Message Operations

```ts
export type MessageDelivery =
	| "auto"
	| "prompt"
	| "steer"
	| "follow_up";

export interface SendMessageInput {
	readonly sessionId: string;
	readonly message: AgentInputMessage;
	readonly delivery?: MessageDelivery;
	readonly idempotencyKey: string;
}

export interface SendMessageResult {
	readonly operationId: string;
	readonly messageId: string;
	readonly sessionId: string;
	readonly runId: string;
	readonly acceptedAs: Exclude<MessageDelivery, "auto">;
	readonly runStatus: RunStatus;
}

sendMessage(input: SendMessageInput): Promise<SendMessageResult>;
```

`sendMessage()` 只等待 admission，不等待整个 Agent Run。顶层 `agent.prompt()` 的 Promise 必须由后台 continuation 观察，禁止产生 unhandled rejection。

### 7.4 Run Operations

```ts
getRun(runId: string): Promise<RunInfo | undefined>;
listRuns(sessionId: string): Promise<readonly RunInfo[]>;
abortRun(sessionId: string, runId: string, idempotencyKey: string): Promise<OperationInfo>;
```

`abortRun()` 必须验证 `runId` 正是目标 Session 的当前 active Run，不能只按 Session ID 取消“碰巧正在运行的另一个 Run”。Run 已结束时返回幂等成功或明确的 `run_not_active`，两种策略必须固定；MVP 建议幂等成功。

### 7.5 Manual Compact Operation

```ts
export interface CompactSessionInput {
	readonly sessionId: string;
	readonly idempotencyKey: string;
	readonly signal?: AbortSignal;
}

export interface CompactSessionResult {
	readonly operationId: string;
	readonly sessionId: string;
	readonly status: "running" | "succeeded";
	readonly changed?: boolean;
	readonly beforeTokens?: number;
	readonly afterTokens?: number;
}

compactSession(input: CompactSessionInput): Promise<CompactSessionResult>;
```

手动压缩可以是长操作。HTTP Adapter 默认立即返回 `202 Accepted` 和 `operationId`，完成结果通过 Operation 查询或 SSE 获得。

### 7.6 Query/Event Operations

```ts
getOperation(operationId: string): Promise<OperationInfo | undefined>;
listMessages(sessionId: string, cursor?: string): Promise<MessagePage>;
subscribeSessionEvents(sessionId: string, cursor?: string): AsyncIterable<ServiceEvent>;
```

## 8. 消息 Admission 语义

### 8.1 路由表

```text
Agent state  delivery    Core call             结果
───────────  ──────────  ────────────────────  ──────────────────────────
idle         auto        agent.prompt()        创建 Run
idle         prompt      agent.prompt()        创建 Run
idle         steer       无                    409 agent_not_running
idle         follow_up   无                    409 agent_not_running
running      auto        agent.followUp()      加入当前 Run
running      prompt      无                    409 agent_already_running
running      steer       agent.steer()         加入当前 ReAct loop
running      follow_up   agent.followUp()      当前 loop 收敛后处理
compacting   任意消息     无                    409 agent_compacting
```

Agent 内部阶段仍有更严格限制：

- steer 只在 `react` 阶段接收；
- follow-up 在 `react` 和 `follow_up` 阶段接收；
- closing 阶段两者都拒绝。

Service Runtime 必须把 `AgentStateError` 和 `MessageAdmissionError` 映射为稳定的服务错误，不能把内部错误文本直接作为 API 契约。

### 8.2 原子 admission

同一个进程中，以下步骤之间不得出现 `await`：

```text
1. resolve ready Session
2. inspect Agent state
3. select prompt / steer / followUp
4. invoke selected Agent method
5. record admission result
```

`agent.prompt()` 会在返回 Promise 前同步把 Agent 切换为 running，因此同一事件循环中第二个请求会看到 running，不会启动第二个顶层 Run。

如果 Agent 方法仍因内部 phase 拒绝，Service Runtime 直接返回 admission conflict；MVP 不建立服务层回退队列。

### 8.3 steer 与 follow-up 的插入位置

```text
prompt
  → model
  → current assistant tool calls
  → drain steer
  → model continues current task
  → current ReAct loop converges
  → drain follow-up
  → model handles follow-up
```

steer 不会中断正在执行的 Tool。需要立刻停止执行时，调用 `abortRun()`，等 Agent idle 后再发新的 prompt。

### 8.4 Admission 失败不得写 Transcript

用户消息必须先通过 Agent admission，再提交到产品 Transcript。否则 UI 会出现一条 Core 从未接收的消息。

如果需要先记录 incoming request，应写入 Operation log，而不是立即写成已接收的聊天消息。

## 9. Run 生命周期

```text
absent
  └─ prompt admitted
       ├─ create runId
       ├─ status = running
       └─ observe prompt Promise
            ├─ resolve → succeeded
            ├─ reject AbortError → aborted
            └─ reject other Error → failed
```

约束：

1. 一个 ServiceSession 同时最多一个 running Run。
2. `runId` 必须在调用 `agent.prompt()` 前生成并保留，并通过 `AgentRunOptions.runId` 传入 Core，确保 Service Run、Trace 和立即返回的 HTTP 响应使用同一个 ID。
3. prompt 同步 admission 失败时不得发布 `run.started`。
4. follow-up 和 steer 复用当前 `runId`。
5. Run 完成后清除 Session 的 `activeRunId`。
6. 清除 activeRun 和发布终态事件必须在同一个同步 commit 中完成。
7. Run Promise 的 resolve/reject 必须始终被观察。
8. Run 失败不关闭 Session；Agent 回到 idle 后可以接受新 prompt。

## 10. 手动压缩设计

### 10.1 为什么需要 Core 改动

当前 `ContextManager.compact()` 接收 active `AgentContext`，并由 Agent 在 `before_llm` 或 `llm_error` 时调用。Service Runtime 只有 `ManagedSession.agent`，没有 ContextManager 引用；空闲 Session 也不存在可供外部安全使用的 active run context。

因此不能由 HTTP 层获取 ContextManager 后直接调用。应把手动压缩做成 Agent 的正式独占操作。

### 10.2 Core API 变更

增加手动压缩原因和请求：

```ts
export type CompactReason =
	| "before_llm"
	| "llm_error"
	| "manual";

export interface ManualCompactRequest {
	readonly signal: AbortSignal;
}

export interface ContextManager {
	readonly maxTurns: number;
	readonly turnCount: number;
	consumeTurn(): void;
	beginRun(request: BeginRunContextRequest): Promise<AgentContext>;
	append(context: AgentContext, messages: AgentMessage | readonly AgentMessage[]): void;
	compact(request: CompactRequest): Promise<CompactResult>;
	compactCurrent(request: ManualCompactRequest): Promise<CompactResult>;
	snapshot(): ContextSnapshot;
}
```

`compactCurrent()` 读取并压缩 ContextManager 当前已提交状态，不依赖 active `AgentContext`。它内部调用同一个 Compactor，并传入 `reason: "manual"`。

Agent 增加：

```ts
export interface AgentCompactOptions {
	readonly signal?: AbortSignal;
}

class Agent {
	compact(options?: AgentCompactOptions): Promise<CompactResult>;
}
```

`AgentStatus` 扩展为：

```ts
export type AgentStatus = "idle" | "running" | "compacting";
```

### 10.3 Agent.compact() 状态机

```text
idle
  └─ compact()
       ├─ synchronously set status = compacting
       ├─ create compact AbortController
       ├─ call contextManager.compactCurrent()
       └─ finally set status = idle
            ├─ success → CompactResult
            ├─ abort   → AbortError
            └─ error   → original error
```

如果 Agent 是 running、compacting 或 disposed，`compact()` 必须拒绝且不能调用 Compactor。

`prompt()` 必须只允许 `status === "idle"`。steer 和 follow-up 仍只允许 running。这样可以在 Core 内保证 prompt 与手动压缩不会并发修改 ContextManager。

### 10.4 原子性

手动压缩必须使用 copy-then-commit：

```text
1. snapshot current committed context
2. invoke Compactor with a frozen snapshot
3. await output
4. check abort signal
5. validate/freeze output
6. replace ContextManager state in one synchronous commit
```

Compactor 抛错、输出非法或操作被 abort 时，旧 Context 必须保持不变。

### 10.5 与 run、Transcript 和 turn limit 的关系

- 手动压缩不创建 Run；它创建 `session.compact` Operation。
- 手动压缩不产生 user/assistant Message。
- 手动压缩不修改产品 Transcript。
- 手动压缩不清空 steer/follow-up queue；因为它只能在 Agent idle 时开始，这些 queue 此时本应为空。
- 手动压缩不重置 `turnCount` 或 `maxTurns`。
- Compactor 自己调用外部模型产生的成本应单独计量，不计作 Agent 的 ModelRunner turn，除非未来明确修改计费语义。
- 自动 `before_llm` / `llm_error` compact 行为保持不变。

### 10.6 abort 和 dispose

- 调用方传入的 signal 可以取消本次手动压缩。
- `Session.dispose()` 必须取消正在进行的手动压缩，并等待其退出后再完成释放。
- `Agent.waitForIdle()` 必须同时覆盖 running 和 compacting。
- `abortRun()` 只针对 active Run，不应误取消 compact Operation。
- 如果未来需要单独取消压缩，增加 `abortOperation(operationId)`；MVP 可以只由 close/dispose 或调用方 signal 取消。

### 10.7 无 Compactor 时的语义

`DefaultContextManager` 未配置 Compactor 时，手动压缩成功返回：

```ts
{ changed: false }
```

这不是服务错误，也不修改上下文。

## 11. Operation 幂等

所有外部写操作都应接收 `Idempotency-Key`：

- 相同 owner、Operation 类型和 key 的重复请求返回第一次的 `operationId` 和结果；
- 相同 key 但请求正文不同，返回 `409 idempotency_key_reused`；
- 在幂等记录成功写入前，不得调用 Core；
- Operation 记录需要设置明确保留时间；
- 内存 MVP 允许进程重启后丢失幂等记录，但必须在文档中说明。

这可以避免浏览器超时重试造成重复 prompt、重复 steer 或重复 compact。

## 12. HTTP API

### 12.1 Agent Profiles

```http
POST   /v1/agent-profiles
GET    /v1/agent-profiles
GET    /v1/agent-profiles/{profileId}
PATCH  /v1/agent-profiles/{profileId}
DELETE /v1/agent-profiles/{profileId}
```

### 12.2 Sessions

```http
POST   /v1/sessions
GET    /v1/sessions
GET    /v1/sessions/{sessionId}
PATCH  /v1/sessions/{sessionId}
DELETE /v1/sessions/{sessionId}
```

创建示例：

```json
{
  "agentProfileId": "general-agent",
  "title": "New conversation"
}
```

### 12.3 Messages

```http
POST /v1/sessions/{sessionId}/messages
```

```json
{
  "content": "Hello",
  "delivery": "auto"
}
```

响应：

```http
HTTP/1.1 202 Accepted
```

```json
{
  "operationId": "op_01...",
  "messageId": "msg_01...",
  "sessionId": "ses_01...",
  "runId": "run_01...",
  "acceptedAs": "prompt",
  "runStatus": "running"
}
```

### 12.4 Runs

```http
GET  /v1/runs/{runId}
POST /v1/runs/{runId}/abort
POST /v1/runs/{runId}/steer
POST /v1/runs/{runId}/follow-ups
```

`steer` 和 `follow-ups` 也可以统一通过 messages endpoint 的 `delivery` 字段发送。独立 endpoint 主要为需要严格语义的 API 客户端提供。

### 12.5 Manual Compact

```http
POST /v1/sessions/{sessionId}/compact
Idempotency-Key: compact-client-001
```

MVP 请求正文为空：

```json
{}
```

响应：

```http
HTTP/1.1 202 Accepted
```

```json
{
  "operationId": "op_01...",
  "sessionId": "ses_01...",
  "type": "session.compact",
  "status": "running"
}
```

完成结果：

```json
{
  "operationId": "op_01...",
  "sessionId": "ses_01...",
  "type": "session.compact",
  "status": "succeeded",
  "result": {
    "changed": true,
    "beforeTokens": 18240,
    "afterTokens": 4380
  }
}
```

Agent 非 idle 时返回：

```http
HTTP/1.1 409 Conflict
```

```json
{
  "error": {
    "code": "session_not_idle",
    "message": "Manual compact requires an idle Session."
  }
}
```

### 12.6 Operations、Messages 和 Events

```http
GET /v1/operations/{operationId}
GET /v1/sessions/{sessionId}/messages
GET /v1/sessions/{sessionId}/events
GET /v1/sessions/{sessionId}/trace
```

`events` 是产品 Service Event；`trace` 是 Agent/Tool 执行事实流。二者都使用 SSE，并支持 `Last-Event-ID` 或 cursor 恢复。Trace 的 cursor、过滤、背压和 replay 语义由 `tool-call-trace-spec.md` 定义。

## 13. 事件模型

MVP 至少发布：

```ts
export type ServiceEventType =
	| "session.creating"
	| "session.ready"
	| "session.closed"
	| "message.accepted"
	| "run.started"
	| "run.succeeded"
	| "run.failed"
	| "run.aborted"
	| "compact.started"
	| "compact.succeeded"
	| "compact.failed"
	| "compact.aborted";
```

公共 envelope：

```ts
export interface ServiceEvent {
	readonly id: string;
	readonly type: ServiceEventType;
	readonly timeUnixMs: number;
	readonly ownerId: string;
	readonly sessionId: string;
	readonly operationId?: string;
	readonly runId?: string;
	readonly data?: unknown;
}
```

Tool Call Trace 是更底层的执行事实源，可以桥接到 SSE，但 Service Event 不应复制或改变 Trace 事件的含义。

MVP 没有 token streaming 时，只发布最终 assistant message。以后增加 token delta 时，必须明确 delta 是临时展示数据，最终 Message 才是 Transcript 事实。

## 14. 错误模型和 HTTP 映射

```ts
export interface ServiceError {
	readonly code: string;
	readonly message: string;
	readonly retryable: boolean;
	readonly details?: Readonly<Record<string, unknown>>;
}
```

建议映射：

| 情况 | code | HTTP |
| --- | --- | --- |
| 输入或 Session ID 非法 | `invalid_request` | 400 |
| 未认证 | `unauthenticated` | 401 |
| 无权访问 Session | `forbidden` | 403 |
| Session/Profile/Run 不存在 | `not_found` | 404 |
| Agent 已运行 | `agent_already_running` | 409 |
| steer/follow-up phase 不接收 | `message_not_admitted` | 409 |
| 手动压缩时 Session 非 idle | `session_not_idle` | 409 |
| Idempotency-Key 被不同请求复用 | `idempotency_key_reused` | 409 |
| Agent turn limit 已耗尽 | `agent_turn_limit_reached` | 409 |
| SessionRuntime 达到容量 | `session_capacity_reached` | 429 |
| Runtime 正在关闭 | `runtime_unavailable` | 503 |
| Provider/Tool/Compactor 内部失败 | `operation_failed` | 500/502 |

内部 stack、Provider 响应正文和密钥不得直接返回客户端。

## 15. Transcript 和 Context 持久化

### 15.1 MVP

第一版可以使用内存实现：

- `SessionRuntime`：真实 Session 所有者；
- `Map`：ServiceSession、Run 和 Operation；
- 内存 TranscriptStore；
- 内存 EventPublisher。

必须明确：进程退出后 Session、上下文、操作状态和消息都会丢失。

### 15.2 持久化版本

正式服务建议持久化：

- AgentProfile；
- Session metadata 和 owner；
- Product Transcript；
- Run/Operation 状态；
- Event cursor；
- ContextManager checkpoint。

只保存 Product Transcript 不足以精确恢复 Agent Context，因为 compact 后的模型上下文可能与完整聊天记录不同。恢复能力应由持久化 ContextManager 或明确的 Context checkpoint 提供。

## 16. 并发和部署约束

MVP 是单进程设计。同一个 Session 的所有 Operation 必须到达拥有该 Session 对象的进程。

如果以后部署多个实例，至少需要：

1. `sessionId → worker/instance` 的所有权路由；
2. Session lease 和心跳；
3. 同一 Session 的单写者约束；
4. 持久化 Run/Operation/Event；
5. 实例退出时的恢复或显式 Session 失败语义。

不能仅仅把 HTTP 服务复制成多个无状态实例，因为 `Session`、Agent Context 和 Tool 实例当前都在进程内存中。

## 17. 安全与限制

1. 每个 Session Operation 都必须验证 owner。
2. AgentProfile 只能引用服务端 allowlist 中的模型和 Tool。
3. Provider key 不进入 Profile API、事件或 Transcript。
4. 对每个 owner 设置 Session 数、并发 Run、消息大小和请求频率限制。
5. 图片和大文件先上传到受控存储，Message 使用资源引用；不要无限制接收 base64。
6. Tool 外部副作用使用 session/user namespace。
7. close、abort 和 compact 写入审计 Operation。
8. SSE 只能订阅调用方有权访问的 Session。

## 18. 实施顺序

### Phase 1：Core 手动压缩

1. 扩展 `CompactReason`，加入 `manual`。
2. 给 `ContextManager` 增加 `compactCurrent()`。
3. 在 `DefaultContextManager` 实现 copy-then-commit 的 idle compact。
4. 给 Agent 增加 `compacting` 状态和 `compact()`。
5. 让 `prompt()`、`compact()` 和 `dispose()` 正确互斥。
6. 让 `waitForIdle()` 覆盖手动压缩。
7. 增加成功、no-op、失败、abort、dispose 和并发 admission 测试。

### Phase 2：协议无关 Service Runtime

1. 新建 `packages/agent-service`。
2. 实现 AgentProfile resolver。
3. 实现 ServiceSession、Run 和 Operation registry。
4. 实现 create/get/list/close Session。
5. 实现 sendMessage 的同步 admission 和后台 Run observation。
6. 实现 abortRun 和 compactSession。
7. 实现 TranscriptStore 和 EventPublisher 接口。
8. 使用内存 adapter 完成测试。

### Phase 3：HTTP + SSE

1. 新建 `apps/agent-server`。
2. 实现认证和 owner authorization。
3. 映射 REST API 和稳定错误码。
4. 实现 Idempotency-Key。
5. 实现 SSE 断线重连和 cursor。
6. 增加进程 shutdown，依次停止 admission、关闭 SSE、dispose Runtime。

### Phase 4：持久化和生产加固

1. 持久化 Profile、Transcript、Run、Operation 和 Event。
2. 实现持久化 ContextManager/checkpoint。
3. 增加 quota、rate limit、审计和可观测性。
4. 再决定是否需要多实例 Session owner routing。

## 19. 测试与验收标准

### 19.1 Message Admission

1. idle + auto 创建新 Run 并调用一次 prompt。
2. running + auto 调用 followUp，不创建新 Run。
3. running + steer 调用 steer，复用当前 runId。
4. idle + steer/follow-up 返回 409。
5. running + prompt 返回 409。
6. closing 阶段拒绝 steer/follow-up，服务不建立隐藏队列。
7. admission 失败的消息不进入 Transcript。
8. 同一 Idempotency-Key 重试不重复调用 Agent。
9. 两个 Session 的消息可以并发，状态和消息不串线。

### 19.2 Run 和 Abort

1. prompt resolve 后 Run 为 succeeded。
2. provider/tool error 后 Run 为 failed，Session 回到 ready/idle。
3. abort 后 Run 为 aborted，Session 仍可启动下一 Run。
4. abort 旧 runId 不得取消当前新 Run。
5. close Session 会取消 active Run 并释放 Tool。

### 19.3 Manual Compact

1. idle Session 可以手动压缩并返回 changed/tokens。
2. 未配置 Compactor 时成功返回 `changed: false`。
3. running 或 compacting 时返回 409，Compactor 不被调用。
4. compacting 时 prompt、steer 和 follow-up 均被拒绝。
5. compact 成功后下一次 prompt 使用压缩后的 Context。
6. compact 失败时 Context snapshot 完全不变。
7. compact abort 时 Context snapshot 完全不变。
8. Session dispose 会取消并等待 active compact。
9. 手动 compact 不修改 Product Transcript。
10. 手动 compact 不修改 `turnCount` 和 `maxTurns`。
11. 相同 Idempotency-Key 不会重复执行 Compactor。
12. 一个 Session compact 时，其他 Session 仍可正常运行。

### 19.4 HTTP/SSE

1. 所有资源执行 owner authorization。
2. HTTP 状态码和稳定 error code 符合本 Spec。
3. SSE 事件顺序与 Run/Operation 状态一致。
4. 客户端断线后可以通过 cursor 补取未读事件。
5. 内部错误和事件不泄漏凭证、stack 或未脱敏 Tool 数据。

## 20. 完成定义

当以下条件同时成立时，Service Runtime v0.1 完成：

- 可以选择 AgentProfile 创建多个独立 Session；
- 可以按 Session 发送 prompt、steer 和 follow-up；
- Service Runtime 复用 Agent 已有 queue，没有第二套 run-local 消息队列；
- 每个顶层 prompt 都有可查询的 runId 和唯一终态；
- 可以按 runId 安全 abort，且不会销毁 Session；
- 可以显式 close Session 并释放所有资源；
- 可以在 idle 时手动 compact Context，并保证失败不改变旧状态；
- 手动 compact 不改变 Transcript 或 turn limit；
- 所有写操作支持幂等；
- HTTP 客户端可以通过查询或 SSE 获得最终状态；
- 一个 Session 的运行、失败、取消或压缩不影响其他 Session。
