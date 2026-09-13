# Tool Call Trace / Execution Log Spec

状态：Draft v0.1

适用范围：`@ailoha/agent-core` 及其上层 Session 运行时

首个实现目标：本地结构化事件流 + JSONL 文件 Sink + 可续订的进程内事件订阅

## 1. 背景与问题

当前 Agent Core 能正确执行 LLM → tool → LLM 的 ReAct 流程，也能在 tool 不存在、参数非法、执行报错或 run 被取消时生成对应的 `ToolResultMessage`。但这些消息属于模型上下文，不是完整、不可变的执行记录：

- compact 可以替换旧消息，事后无法还原原始调用链；
- 只看最终消息，无法区分 tool 是等待执行、真正开始执行，还是未执行即被跳过；
- 没有稳定的 run、assistant turn、tool execution 关联 ID；
- 缺少排队耗时、执行耗时、失败阶段和取消原因等诊断信息；
- 直接用 `console.log` 记录 arguments/result 容易泄露密钥、个人信息和大体积内容；
- 上层 UI、CLI、测试和未来遥测如果各自埋点，会产生不一致的状态定义。

一个典型问题如下：模型一次返回两个 tool calls，第一项执行时用户取消了 run。消息历史最终会包含第一项 `cancelled` 和第二项 `skipped` 的 tool results，但仅靠普通日志很难回答：第一项实际执行了多久、第二项是否曾进入 `execute()`、它们来自哪一次模型输出。

本 Spec 引入一套独立于 context history 的结构化 Trace 事件流。Trace 是事实源；控制台执行日志、JSONL 文件、调试 UI 和未来的遥测导出都只是该事件流的不同 Sink 或 View。

## 2. 目标

MVP 必须做到：

1. 每次顶层 `prompt()` 都有唯一的 `runId`。
2. 每个 assistant tool call 都能从“请求产生”追踪到唯一终态。
3. 能明确区分 requested、started、success、error、cancelled 和 skipped。
4. 能关联 session、run、assistant turn、provider tool call 和本地 execution。
5. 能记录排队耗时、实际执行耗时和总耗时。
6. Trace 失败不得改变 Agent 的执行结果、消息顺序或取消语义。
7. arguments、result 和 error 必须经过统一的采集、脱敏与截断策略。
8. 事件必须可追加写入、可按 ID 去重、可在进程内按严格顺序消费。
9. 不依赖完整 transcript，也不把 Trace 事件写入模型 context。
10. 允许多个观察者按 Session、Run、事件类型或 Tool 订阅同一事实流。
11. 慢订阅者、断开的客户端或订阅回调失败不得阻塞 Agent 执行。

## 3. 非目标

MVP 不实现：

- 分布式跨服务 tracing 后端；
- 完整 prompt、模型输出或 token streaming 记录；
- tool 自动重试；`attempt` 字段只为未来兼容预留；
- tool 并发调度；仍遵守当前按 assistant 输出顺序串行执行的规则；
- 用 Trace 恢复或重放 Agent run；
- 通用 hook/plugin 系统；
- 在 Agent Core 内提供日志搜索数据库或 Web UI；
- 保证进程崩溃前尚未落盘的内存事件一定持久化；
- 仅依靠内存订阅实现跨进程重放；
- 对订阅消费者提供 exactly-once 投递。

## 4. 核心设计决定

### 4.1 一套事件，两种用途

不分别实现“trace 系统”和“execution log 系统”。Agent Core 只产生结构化 `TraceEvent`：

- Trace 视图根据关联 ID 和时间计算调用链；
- 人类可读日志把同一事件格式化为文本；
- JSONL Sink 原样持久化事件；
- 测试使用内存 Sink 断言事件顺序和字段；
- 未来接入 OpenTelemetry 时通过 adapter 转换，不把外部协议类型泄漏进 Core。

### 4.2 Trace 与 context history 相互独立

`ToolResultMessage` 是发给下一次 LLM 的协议消息；`TraceEvent` 是运行时观察数据。两者不得互相替代：

- compact 只能改变 context history，不能删除既有 Trace 事件；
- Trace Sink 失败不能阻止 `ToolResultMessage` 提交；
- Trace 中的截断或脱敏不能改变传给 LLM 的真实 tool result；
- Trace 不能作为 Agent 循环的控制输入。

### 4.3 生命周期采用 requested → started? → finished

每个 tool call 必须有：

```text
tool.call.requested
  ├─ tool.call.started → tool.call.finished(success | error | cancelled)
  └─ tool.call.finished(error | cancelled | skipped)
```

`started` 是可选事件，因为以下情况不会进入 `tool.execute()`：

- tool name 未注册；
- arguments schema 校验失败；
- 轮到该 tool 前 run 已取消；
- 前一个 tool 执行期间 run 取消，本轮剩余 tool 被跳过。

所有正常存活到终态的 `requested` 必须恰好对应一个 `finished`。进程崩溃是唯一允许留下 open execution 的情况。

### 4.4 Sink、Hub 与订阅职责分离

`TraceRecorder` 只负责产生事实，`TraceSink` 只负责接收事实。需要实时订阅时，使用同时实现 `TraceSink` 和 `TraceSource` 的 `TraceEventHub`：

```text
Agent
  → TraceRecorder
     → TraceEventHub
        ├─ bounded replay ring
        ├─ Subscriber A
        ├─ Subscriber B
        ├─ JsonlTraceSink
        └─ ConsoleTraceSink
```

约束：

- Agent 不知道订阅者数量，也不等待订阅者消费；
- Hub 只分发 Recorder 已经完成脱敏、截断和冻结的 `TraceEvent`；
- 订阅层不得产生或修改 Agent lifecycle 事实；
- 订阅 gap、cursor expired 和 heartbeat 是传输控制信息，不属于 `TraceEvent`；
- JSONL 等持久化 Sink 与实时订阅使用同一份事件对象，不能各自重新采集 payload。

## 5. 标识与关联

| 字段 | 生成方 | 生命周期 | 用途 |
| --- | --- | --- | --- |
| `sessionId` | Session | Session 生命周期 | 关联同一 Session 的多个 run |
| `runId` | 调用方或 Agent | 每次顶层 `prompt()` | 一次完整 ReAct + follow-up run；服务层可预生成 |
| `assistantTurnId` | Agent | 每次成功取得 assistant message | 关联同一次模型输出中的多个 tool calls |
| `toolCallId` | 模型 Provider | Provider tool call | 对应消息协议中的 `ToolCall.id` |
| `toolExecutionId` | Agent | 每个 observed tool call | Trace 内部稳定主键 |
| `eventId` | TraceRecorder | 每个事件 | 持久化重试时去重 |
| `sequence` | TraceRecorder | run 内递增 | 确定同一 run 的严格事件顺序 |
| `correlationId` | 可选，由调用方传入 | 外部请求生命周期 | 关联 HTTP request、job 或产品任务 |
| `cursor` | TraceEventHub/Store | 每个 Hub 接收记录 | 全局排序、replay 和断线续订；不写入 TraceEvent 本体 |

约束：

- `toolCallId` 不得作为 Trace 主键。不同 Provider 或不同模型调用可能复用它。
- `AgentRunOptions.runId` 存在时使用调用方提供的值；省略时由 Agent 生成。服务调用方负责保证预生成 ID 在自己的 Trace domain 中唯一。
- `toolExecutionId` 在 `tool.call.requested` 时生成，并在后续 started/finished 事件中保持不变。
- `sequence` 从 1 开始，在同一 `runId` 内严格递增且不重复。
- ID 默认使用 UUIDv7 或具有相同排序与唯一性能力的实现；测试必须允许注入确定性 ID generator。
- `eventId` 是事件身份，消费者用它去重；`cursor` 是某个事件源中的位置，消费者用它续订。
- 不得用 `eventId` 的字典序代替 cursor，也不得用 run-local `sequence` 对多个 Run 做全局排序。
- 内存 Hub 的 cursor 只在该 Hub 生命周期内有效；持久化 Store 可以定义跨进程有效的 cursor。

## 6. 事件模型

### 6.1 公共 Envelope

```ts
interface TraceEventBase {
	readonly schemaVersion: 1;
	readonly eventId: string;
	readonly type: TraceEventType;
	readonly timeUnixMs: number;
	readonly sequence: number;
	readonly sessionId: string;
	readonly runId: string;
	readonly correlationId?: string;
	readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

type TraceEventType =
	| "agent.run.started"
	| "agent.run.finished"
	| "tool.call.requested"
	| "tool.call.started"
	| "tool.call.finished";
```

所有事件必须是 JSON 可序列化的只读快照。不得在 emit 后继续修改对象、数组或嵌套值。

### 6.2 Run 事件

```ts
interface RunStartedEvent extends TraceEventBase {
	readonly type: "agent.run.started";
	readonly inputMessageCount: number;
	readonly model: {
		readonly provider?: string;
		readonly id: string;
	};
}

type RunOutcome = "success" | "error" | "cancelled";

interface RunFinishedEvent extends TraceEventBase {
	readonly type: "agent.run.finished";
	readonly outcome: RunOutcome;
	readonly durationMs: number;
	readonly assistantTurnCount: number;
	readonly toolCallCount: number;
	readonly error?: CapturedError;
}
```

规则：

- `agent.run.started` 在 Agent 同步切换为 `running` 并建立 active run 后、`beginRun()` 前发出。
- `agent.run.finished` 在 run 结果已确定、队列和 active state 已清理时发出。
- 用户取消或 Session dispose 导致的 abort 使用 `outcome: "cancelled"`，不能归类为普通 error。
- 一次已开始且进程未崩溃的 run 必须恰好有一个 finished 事件。

### 6.3 Tool 请求事件

```ts
interface ToolCallRequestedEvent extends TraceEventBase {
	readonly type: "tool.call.requested";
	readonly assistantTurnId: string;
	readonly toolExecutionId: string;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly ordinal: number;
	readonly attempt: 1;
	readonly arguments: CapturedValue;
}
```

规则：

- assistant message 成功写入 context 后，为其中所有 tool calls 按输出顺序连续产生 requested 事件。
- `ordinal` 是该 assistant message 内 tool call 的零基索引。
- 同一 assistant message 中的所有 requested 必须先于任一 started。这样可以看出后续 tool 是“已请求但仍在排队”，而不是尚未被发现。
- arguments 记录模型原始 `ToolCall.arguments` 的采集快照，不记录 schema 校验后的推测值。

### 6.4 Tool 开始事件

```ts
interface ToolCallStartedEvent extends TraceEventBase {
	readonly type: "tool.call.started";
	readonly assistantTurnId: string;
	readonly toolExecutionId: string;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly ordinal: number;
	readonly attempt: 1;
	readonly queueDurationMs: number;
}
```

规则：

- 只有即将调用 `tool.execute()` 时才产生 started。
- started 必须在最后一次 `signal.throwIfAborted()` 检查通过之后、调用 `execute()` 之前同步产生。
- `queueDurationMs = started.monotonicTime - requested.monotonicTime`。序列化事件只保存计算后的毫秒数，不依赖墙上时钟倒退与否。

### 6.5 Tool 终态事件

```ts
type ToolOutcome = "success" | "error" | "cancelled" | "skipped";
type ToolFailureStage = "lookup" | "validation" | "execution" | "cancellation";

interface ToolCallFinishedEvent extends TraceEventBase {
	readonly type: "tool.call.finished";
	readonly assistantTurnId: string;
	readonly toolExecutionId: string;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly ordinal: number;
	readonly attempt: 1;
	readonly outcome: ToolOutcome;
	readonly failureStage?: ToolFailureStage;
	readonly totalDurationMs: number;
	readonly executionDurationMs?: number;
	readonly result?: CapturedValue;
	readonly error?: CapturedError;
}
```

终态映射：

| 运行情况 | 有 started | `outcome` | `failureStage` |
| --- | --- | --- | --- |
| `execute()` 返回且 `isError !== true` | 是 | `success` | 无 |
| `execute()` 返回 `isError: true` | 是 | `error` | `execution` |
| `execute()` 抛出非取消异常 | 是 | `error` | `execution` |
| tool 不存在 | 否 | `error` | `lookup` |
| arguments 非法 | 否 | `error` | `validation` |
| 当前调用开始前检测到取消 | 否 | `cancelled` | `cancellation` |
| 已在执行的调用因 abort 结束 | 是 | `cancelled` | `cancellation` |
| 同一 assistant message 中尚未执行的剩余调用 | 否 | `skipped` | `cancellation` |

计时规则：

- `totalDurationMs` 从 requested 到 finished。
- `executionDurationMs` 只在存在 started 时提供，从 started 到 finished。
- duration 使用 monotonic clock 计算，值必须大于等于 0。
- `timeUnixMs` 仅用于跨事件展示和粗粒度排序。

### 6.6 采集值与错误

```ts
type CaptureMode = "none" | "metadata" | "redacted" | "full";

interface CapturedValue {
	readonly mode: CaptureMode;
	readonly value?: unknown;
	readonly byteLength?: number;
	readonly sha256?: string;
	readonly truncated?: boolean;
	readonly originalByteLength?: number;
}

interface CapturedError {
	readonly name: string;
	readonly code?: string;
	readonly message: string;
	readonly stack?: string;
	readonly retryable?: boolean;
}
```

`metadata` 模式只记录类型、序列化后字节数和可选 hash，不保存正文。`redacted` 模式在脱敏后保存 `value`。`full` 仍受最大字节数限制，并不代表无限制原样记录。

## 7. API 设计

### 7.1 Sink 与 Recorder

```ts
interface TraceSink {
	emit(event: TraceEvent): void;
	flush?(): Promise<void>;
	dispose?(): Promise<void>;
}

interface TraceCapturePolicy {
	readonly arguments?: CaptureMode; // default: "redacted"
	readonly results?: CaptureMode;   // default: "metadata"
	readonly errors?: "message" | "stack"; // default: "message"
	readonly maxValueBytes?: number;  // default: 32 KiB
	readonly redactKeys?: readonly string[];
	readonly perTool?: Readonly<Record<string, Partial<TraceCapturePolicy>>>;
	readonly redact?: (input: {
		readonly toolName: string;
		readonly kind: "arguments" | "result" | "error";
		readonly value: unknown;
	}) => unknown;
}

interface TraceOptions {
	readonly enabled?: boolean; // default: true when sink exists
	readonly sink: TraceSink;
	readonly sinkOwnership?: "session" | "external"; // default: "session"
	readonly capture?: TraceCapturePolicy;
	readonly sessionAttributes?: Readonly<Record<string, string | number | boolean>>;
	readonly onError?: (error: Error) => void;
	readonly clock?: TraceClock;
	readonly idGenerator?: TraceIdGenerator;
}
```

Agent 不直接散落调用任意 Sink，而是依赖一个内部 `TraceRecorder`。Recorder 统一负责：

- 生成 ID 和 `sequence`；
- 读取 wall clock 与 monotonic clock；
- 冻结事件快照；
- 对 payload 采集、脱敏、截断和安全序列化；
- 隔离 Sink 异常；
- 在测试中提供确定性时钟和 ID。

### 7.2 Session 接入

```ts
interface SessionOptions {
	// existing fields...
	readonly trace?: false | TraceOptions;
}

interface AgentRunOptions {
	readonly runId?: string;
	readonly correlationId?: string;
	readonly traceAttributes?: Readonly<Record<string, string | number | boolean>>;
}

class Agent {
	prompt(
		input: string | AgentInputMessage | readonly AgentInputMessage[],
		options?: AgentRunOptions,
	): Promise<RunResult>;
}
```

约束：

- `Session.create()` 创建 `sessionId` 和 Session 生命周期 Recorder。
- 每次 `agent.prompt()` 创建 run-local recorder scope；使用 `options.runId` 或生成新的 `runId`。
- `prompt()` 必须在返回 Promise 前同步校验并确定 runId。Service Runtime 可以先生成 runId、传入 `prompt()`，然后立即向 HTTP 客户端返回同一个 ID。
- `correlationId` 和 run 级 attributes 由 `prompt()` 的第二个参数传入，不能固定在 Session 配置中，否则同一 Session 的多个外部请求无法正确区分。
- 未配置 `trace` 时使用 no-op recorder，不应在业务路径中出现重复的 `if (trace)` 分支。
- `sinkOwnership: "session"` 时，`Session.dispose()` 尝试 flush/dispose Sink；默认不因遥测失败而把一次已成功的 Agent run 改成失败。
- `sinkOwnership: "external"` 时，Session 不 flush/dispose Sink。共享 `TraceEventHub` 必须使用 external，由创建它的 Service Runtime 在所有 Session 停止后统一关闭。
- `RunResult` 增加只读 `runId`，便于上层把结果和日志关联。

### 7.3 Tool 内部自定义事件

MVP 不向 `ToolExecutionContext` 暴露任意 lifecycle emit 能力，避免 tool 伪造 `started` 或 `finished`。如果未来需要记录 HTTP、子进程等 tool 内部 span，可增加受限接口：

```ts
interface ToolTraceContext {
	span<T>(name: string, attributes: Record<string, TraceAttribute>, fn: () => Promise<T>): Promise<T>;
	event(name: string, attributes?: Record<string, TraceAttribute>): void;
}
```

该能力属于下一阶段，不阻塞 MVP。

### 7.4 订阅 API

订阅以 `AsyncIterable` 为主接口，不执行用户回调。这样可以自然表达异步消费、取消和背压，并方便桥接 SSE、WebSocket、CLI 和测试。

```ts
export type TraceCursor = string;

export interface TraceRecord {
	readonly kind: "event";
	readonly cursor: TraceCursor;
	readonly event: TraceEvent;
}

export interface TraceGap {
	readonly kind: "gap";
	readonly droppedCount: number;
	readonly afterCursor?: TraceCursor;
	readonly nextCursor: TraceCursor;
}

export type TraceDelivery = TraceRecord | TraceGap;

export interface TraceFilter {
	readonly sessionIds?: readonly string[];
	readonly runIds?: readonly string[];
	readonly eventTypes?: readonly TraceEventType[];
	readonly toolNames?: readonly string[];
	readonly outcomes?: readonly (RunOutcome | ToolOutcome)[];
}

export type TraceSubscriptionStart =
	| { readonly mode: "latest" }
	| { readonly mode: "after"; readonly cursor: TraceCursor }
	| { readonly mode: "earliest_available" };

export interface TraceSubscriptionOptions {
	readonly start?: TraceSubscriptionStart; // default: latest
	readonly filter?: TraceFilter;
	readonly bufferCapacity?: number;
	readonly overflow?: "close" | "drop_oldest"; // default: close
	readonly signal?: AbortSignal;
}

export interface TraceSubscriptionSnapshot {
	readonly id: string;
	readonly status: "open" | "closed";
	readonly deliveredEvents: number;
	readonly filteredEvents: number;
	readonly droppedEvents: number;
	readonly lastDeliveredCursor?: TraceCursor;
	readonly closeReason?: string;
}

export interface TraceSubscription extends AsyncIterable<TraceDelivery> {
	readonly id: string;
	close(reason?: unknown): void;
	snapshot(): TraceSubscriptionSnapshot;
}

export interface TraceSource {
	subscribe(options?: TraceSubscriptionOptions): TraceSubscription;
}
```

基础实现：

```ts
export interface TraceEventHubOptions {
	readonly replayCapacity?: number; // default: 10_000 records
	readonly defaultSubscriberBufferCapacity?: number; // default: 1_000
	readonly sinks?: readonly TraceSink[];
	readonly generateSubscriptionId?: () => string;
	readonly encodeCursor?: (offset: bigint) => TraceCursor;
	readonly onError?: (error: Error) => void;
}

export class TraceEventHub implements TraceSink, TraceSource {
	constructor(options?: TraceEventHubOptions);
	emit(event: TraceEvent): void;
	subscribe(options?: TraceSubscriptionOptions): TraceSubscription;
	flush(): Promise<void>;
	dispose(): Promise<void>;
}
```

Hub 的 `emit()` 必须保持同步、无 await，并且对 Agent 表现为 no-throw。事件进入 Hub 后，Hub 在同一同步步骤中：

1. 分配严格递增的内部 offset 并编码成 opaque cursor；
2. 创建冻结的 `TraceRecord`；
3. 写入有界 replay ring；
4. 按过滤器投递到各订阅者的独立缓冲区；
5. 把同一个 `TraceEvent` 交给下游 Sink。

任何订阅者或下游 Sink 失败都不能终止其他分支，也不能抛回 Agent。

使用示例：

```ts
const hub = new TraceEventHub({
	sinks: [new JsonlTraceSink({ path: tracePath })],
});

const subscription = hub.subscribe({
	start: { mode: "latest" },
	filter: {
		sessionIds: [sessionId],
		eventTypes: ["tool.call.started", "tool.call.finished"],
	},
	signal: requestSignal,
});

for await (const delivery of subscription) {
	if (delivery.kind === "gap") {
		await notifyGap(delivery);
		continue;
	}
	await sendToClient(delivery.cursor, delivery.event);
}
```

`sendToClient()` 可以慢，但它只拖慢该订阅的消费；达到 buffer 上限后执行该订阅的 overflow 策略，不会阻塞 `TraceEventHub.emit()`。

## 8. Agent 埋点位置与顺序

必须按以下位置埋点，不能只在 `tool.execute()` 外包一层，因为 lookup、validation、排队取消和 skipped 都不会完整经过该函数。

```text
prompt() 建立 active run
  emit run.started
  beginRun()
  ReAct loop
    compact()
    modelRunner.run()
    append assistant message
    为本条 assistant 的全部 calls 依次 emit requested
    for each tool call
      lookup tool
        失败 → emit finished(error/lookup)
      validate arguments
        失败 → emit finished(error/validation)
      signal.throwIfAborted()
        失败 → 当前 emit finished(cancelled)
               剩余 emit finished(skipped)
      emit started
      tool.execute()
        成功 → emit finished(success)
        isError → emit finished(error/execution)
        throw → emit finished(error/execution)
        abort → 当前 emit finished(cancelled)
                剩余 emit finished(skipped)
      append ToolResultMessage
    drain steer
  drain follow-up
  cleanup active run
  emit run.finished
```

重要不变量：

1. Trace emit 不得改变现有 context message 顺序。
2. 所有 requested 必须在第一项 started 前发出。
3. 同一个 `toolExecutionId` 最多一个 started、恰好一个 finished。
4. 没有 started 的 execution 不能有 `executionDurationMs`。
5. `success` 只能来自真实进入过 `execute()` 的调用。
6. `skipped` 只能表示该调用从未进入 `execute()`。
7. 取消闭合 Trace 的顺序必须与取消闭合 `ToolResultMessage` 的顺序一致。
8. Sink 抛错、序列化失败或缓冲区溢出都不能改变上述语义。

## 9. 脱敏与安全

### 9.1 默认策略

- arguments：`redacted`；
- results：`metadata`；
- errors：只记录脱敏后的 name、code、message，不记录 stack；
- 单值上限：32 KiB UTF-8；
- image/binary：只记录 mime type、大小和 hash，不记录 base64 数据；
- system prompt、完整 context、环境变量和进程启动参数：永不由本 Spec 的事件自动采集。

### 9.2 内置敏感键

键名匹配不区分大小写，并忽略 `_`、`-` 差异。至少包含：

```text
authorization, proxy-authorization, cookie, set-cookie,
password, passwd, secret, client-secret,
api-key, apikey, access-token, refresh-token,
private-key, credential
```

匹配值替换为 `"[REDACTED]"`。递归对象必须设置最大深度和最大节点数，防止异常输入消耗过量 CPU/内存。

内置键规则只能降低常见误泄露风险，不能识别自由文本中的全部秘密。处理高敏 tool 时必须配置 `perTool` 策略或自定义 `redact()`。

### 9.3 截断与序列化

- 截断必须在脱敏之后执行，避免为了计算预览而再次保留原始值。
- 截断事件必须标记 `truncated: true` 和 `originalByteLength`。
- 遇到循环引用、BigInt、Error、Date、Map 等值时使用确定性的 safe serializer。
- 无法安全序列化时降级为 `metadata`，并通过 `onError` 报告；不能抛回 Agent loop。
- hash 在原始内容可能是低熵秘密时也可能形成离线猜测风险，因此 `sha256` 默认只用于大体积 result/binary，arguments 默认不开启。

## 10. Sink 行为

### 10.1 InMemoryTraceSink

用于单元测试和本地调试：

- 保留事件插入顺序；
- 提供只读 snapshot；
- 支持按 `runId`、`toolExecutionId` 过滤；
- 必须设置可配置的最大事件数，避免无界增长。

### 10.2 JsonlTraceSink

首个持久化实现，一行一个完整 JSON event：

```json
{"schemaVersion":1,"eventId":"evt_01...","type":"tool.call.finished","timeUnixMs":1789203600123,"sequence":8,"sessionId":"ses_01...","runId":"run_01...","assistantTurnId":"turn_01...","toolExecutionId":"tex_01...","toolCallId":"call_abc","toolName":"search","ordinal":0,"attempt":1,"outcome":"success","totalDurationMs":142.7,"executionDurationMs":141.9,"result":{"mode":"metadata","byteLength":4821}}
```

要求：

- UTF-8，一行一个事件，以 `\n` 结束；
- 单个事件必须一次性排入 Sink 的写队列，避免行内容交叉；
- 同一进程内按 emit 顺序写入；
- exporter 重试允许 at-least-once，消费者使用 `eventId` 去重；
- 支持按日期或文件大小轮转，轮转策略由应用层配置；
- 文件权限、目录和保留周期由宿主应用决定，Core 不写死用户目录；
- flush 应等待已接收事件写完，但不接受新的业务控制语义。

### 10.3 ConsoleTraceSink

Console 是人类可读 View，不是新的数据模型。建议格式：

```text
17:00:00.010 run=run_01 tool=search exec=tex_01 requested ordinal=0 args={"query":"..."}
17:00:00.011 run=run_01 tool=search exec=tex_01 started queue=1.2ms
17:00:00.153 run=run_01 tool=search exec=tex_01 finished outcome=success exec=141.9ms total=142.7ms result=4.8KB
```

默认不启用 ANSI 颜色，是否着色由终端检测或调用方配置决定。

### 10.4 TraceEventHub

`TraceEventHub` 是实时分发组件，不是持久化数据库。它必须：

- 为所有接收事件分配进程内严格递增的 cursor；
- 保留有界 replay ring；
- 支持多个互不阻塞的订阅者；
- 为每个订阅者维护独立的有界缓冲区；
- 在 emit 路径同步注册事件，但绝不等待异步消费者；
- 过滤之前分配 cursor，保证一个 cursor 在整个 Hub 中只表示一个位置；
- 事件进入 ring 后不得被订阅者修改；
- Hub dispose 后拒绝新订阅并关闭现有订阅；
- 统一 flush/dispose 它拥有的下游 Sink。

建议一个 `AgentServiceRuntime` 共享一个 Hub，并给各 Session 的 `TraceOptions` 传入同一个 Hub 和 `sinkOwnership: "external"`。这样可以使用一个订阅按 owner 授权后观察多个 Session，同时避免关闭一个 Session 时误关整个 Hub。

## 11. 故障隔离与背压

Trace 属于观察路径，默认采用 best-effort：

- `TraceRecorder.emit()` 对 Agent 必须表现为同步、无 throw；
- Sink 内部可以异步落盘或发送，但必须自行排队；
- Sink 抛出的同步异常由 Recorder 捕获并传给 `onError`；
- `onError` 自身抛错也必须被吞掉，不能递归产生 Trace 事件；
- 异步 Sink 缓冲区必须有上限和明确的 overflow 策略；默认 `drop_newest`；
- Sink 必须统计 `acceptedEvents`、`droppedEvents`、`writeErrors`，供 dispose 后诊断；
- 不向同一个失败 Sink 写 `trace.dropped` 事件，否则可能递归失败；
- 默认模式下 flush 失败不改变 run outcome；严格持久化模式未来可由宿主应用在 Core 外实现；
- 每个订阅者必须使用独立缓冲区，慢消费者不得占住 Hub 或其他消费者；
- 订阅缓冲区默认 overflow 策略是 `close`，让消费者明确知道连续性已经丢失；
- 可选 `drop_oldest` 只能在下一次 delivery 前先产生 `TraceGap`，禁止静默丢弃；
- `TraceGap` 是投递状态，不得再次写入持久化 Trace Sink。

“不影响业务”不等于静默丢失。发生 drop 或 write error 时，`onError` 至少在每个错误 burst 首次触发一次，并包含累计丢失数量。

## 12. 事件订阅机制

### 12.1 Live、Replay 与持久化边界

订阅分为三个概念：

```text
live delivery
  → Hub 把新事件推入订阅者 buffer

bounded replay
  → Hub 从内存 ring 重放仍在保留范围内的事件

durable replay
  → 外部 TraceEventStore/日志系统从持久化记录读取
```

MVP 的 `TraceEventHub` 提供前两项。JSONL Sink 负责持久化，但首版不要求直接从 JSONL 高效随机查询。跨进程、长时间范围或审计级 replay 应由上层实现 `TraceEventStore`。

内存 Hub 重启后会产生新的 cursor domain。旧 cursor 不得静默解释成新 Hub 的位置。

### 12.2 Cursor 规则

cursor 是 opaque token，调用方只能保存、比较是否相等和原样传回，不能解析其中 offset。

建议 cursor 编码同时包含 Hub instance ID 和 offset：

```text
cur_<hub-instance-id>_<offset>
```

要求：

1. Hub 中每个接收记录有唯一 cursor。
2. cursor 顺序等于 Hub 的 `emit()` 接收顺序。
3. 过滤掉的事件仍消耗 cursor。
4. `start: latest` 只订阅调用之后的新事件。
5. `start: after` 先 replay 指定 cursor 之后仍可用且匹配的事件，再无缝进入 live。
6. `start: earliest_available` 从 ring 中最早仍可用的位置开始。
7. cursor 属于其他 Hub、格式非法或已早于 ring 保留范围时，同步抛出 `TraceCursorExpiredError` 或 `InvalidTraceCursorError`。
8. `eventId` 用于 at-least-once 场景去重；cursor 不替代 eventId。

cursor error 至少携带当前 `earliestAvailableCursor` 和 `latestCursor`，便于上层决定从持久化 Store 补取还是重新建立 live 订阅。

### 12.3 无缝 replay-to-live

`subscribe()` 必须在一个不含 await 的同步临界区中完成：

```text
1. validate options and cursor
2. capture current tail cursor
3. register subscriber for events after tail
4. prepare replay range: (requested cursor, captured tail]
5. return subscription
```

迭代器必须先产生 replay range，再产生注册后的 live events。任何事件要么位于 replay，要么位于 live，不能落在二者之间，也不能因切换而重复。

如果待 replay 数量超过允许上限，订阅创建应失败并给出范围信息，不能为了建立订阅而无界分配内存。

### 12.4 Filter 语义

一个事件必须满足所有已提供维度才会投递；每个维度内部采用 OR：

```text
sessionIds AND runIds AND eventTypes AND toolNames AND outcomes
```

规则：

- 未提供某维度表示不限制；
- 空数组表示匹配零事件；
- `toolNames` 只匹配 tool 事件，run 事件不匹配；
- `outcomes` 只匹配包含 outcome 的 finished 事件；
- 字符串默认精确且区分大小写；
- MVP 不接受调用方提供任意 predicate 函数，避免不可序列化、异常和高 CPU filter；
- filter 在 Hub 内只用于投递，不能影响 JSONL 等下游 Sink 保存完整事件。

### 12.5 Subscription 生命周期

```text
open
  ├─ consumer next() → wait or receive delivery
  ├─ iterator.return() / close() / signal abort → closed
  ├─ buffer overflow with close policy → closed(error)
  └─ Hub.dispose() → closed(hub_disposed)
```

约束：

- `close()` 幂等；
- `AbortSignal` 已 abort 时，`subscribe()` 返回立即关闭的订阅或同步抛 AbortError，具体选择必须固定；MVP 建议返回关闭订阅；
- `for await` 提前退出必须调用 iterator `return()` 并从 Hub 移除订阅；
- close 后所有 pending `next()` 必须 settle；
- 正常 close 令 iterator 返回 `done: true`；
- overflow 等异常 close 令 pending/next `next()` reject 对应 typed error；
- 一个订阅关闭不得关闭 Hub、Sink 或其他订阅；
- Hub 不保留已关闭订阅的 filter、buffer 或 signal listener。

### 12.6 背压策略

Agent 的 Trace emit 不能等待网络或订阅者，所以每个订阅必须有有界 buffer。

默认策略 `close`：

```text
subscriber buffer full
  → mark subscription closed with TraceSubscriptionOverflowError
  → detach subscriber
  → reject its pending/next next()
  → Agent and other subscribers continue
```

调用方可以使用最后成功处理的 cursor 重新订阅；如果 replay ring 仍覆盖缺失区间，即可补齐，否则收到 cursor expired。

可选策略 `drop_oldest`：

```text
subscriber buffer full
  → remove oldest buffered deliveries
  → accumulate droppedCount
  → enqueue newest event
  → before next event yield one TraceGap
```

`drop_oldest` 适合只关心最新状态的开发 UI，不适合审计、计费或精确执行分析。`TraceGap` 出现后，消费者不得继续声称自己拥有完整 Trace。

### 12.7 多 Sink 故障隔离

Hub 向多个下游 Sink fan-out 时：

1. 按注册顺序同步调用每个 Sink 的 `emit()`；
2. 单个 Sink throw 时记录错误并继续其他 Sink；
3. 不因 Sink throw 撤回已经进入 ring 或 subscriber buffer 的记录；
4. `flush()` 对全部 Sink 执行 `Promise.allSettled()`；
5. `dispose()` 即使部分 Sink 失败也继续关闭其余 Sink 和订阅；
6. 多个关闭错误最终使用 `AggregateError` 报告给 Hub 所有者，但不能改变既有 Agent run outcome。

### 12.8 Web SSE Adapter

Agent Service 层提供独立的 Trace endpoint：

```http
GET /v1/sessions/{sessionId}/trace
Accept: text/event-stream
Last-Event-ID: cur_...
```

可选 query：

```text
types=tool.call.requested,tool.call.started,tool.call.finished
runId=run_01...
toolName=search
outcome=success,error,cancelled,skipped
```

服务端必须忽略客户端传入的任意 `sessionIds` filter，并强制把 filter 锁定为 URL 中且已授权的 Session。跨 Session 订阅只能使用单独的管理 endpoint 和明确权限。

Trace 事件帧：

```text
id: cur_hub01_1042
event: trace
data: {"schemaVersion":1,"eventId":"evt_01...","type":"tool.call.started","sessionId":"ses_01...","runId":"run_01..."}

```

传输控制帧不是 TraceEvent：

```text
event: trace.gap
data: {"droppedCount":42,"afterCursor":"cur_hub01_900","nextCursor":"cur_hub01_943"}

event: trace.error
data: {"code":"trace_cursor_expired","earliestAvailableCursor":"cur_hub01_800","latestCursor":"cur_hub01_1200"}

```

SSE Adapter 要求：

- 使用 `TraceRecord.cursor` 作为 SSE `id`；
- 客户端使用 `event.eventId` 去重；
- `Last-Event-ID` 与 query cursor 同时提供且不一致时返回 400；
- cursor expired 时返回稳定错误或发送 `trace.error` 后关闭，MVP 建议在响应头尚未发送时返回 `409`；
- 定期发送 SSE comment heartbeat，避免代理关闭空闲连接；
- 对长时间没有匹配事件的过滤订阅，可以发送带最新 cursor 的 `trace.watermark` 控制帧，避免客户端 cursor 永久停留在已淘汰区间；
- 客户端断开必须 abort subscription 并立即释放 buffer；
- 禁止缓存响应，并配置合理的连接数、空闲时长和每用户订阅上限；
- Trace payload 在进入 Hub 前已经完成 capture/redaction，SSE Adapter 不得重新读取原始 Tool arguments/result。

### 12.9 与 Service Event 的关系

Trace Event 和产品 Service Event 是两条不同但可关联的流：

```text
TraceEvent
  → Agent/Tool 执行事实
  → runId, toolExecutionId, sequence

ServiceEvent
  → Session、Operation、Message 等产品生命周期
  → operationId, messageId, ownerId
```

二者可以通过 `sessionId`、`runId` 和 `correlationId` 关联，但不能把 Service Event 伪装成 TraceEvent。Web 后端可以提供两个 endpoint，也可以在 UI gateway 进行带 channel 字段的多路复用。

### 12.10 可选持久化 TraceEventStore

需要跨进程续订时，由上层增加：

```ts
export interface TraceEventStore {
	append(record: TraceRecord): Promise<void>;
	read(input: {
		readonly after?: TraceCursor;
		readonly filter?: TraceFilter;
		readonly limit: number;
	}): Promise<{
		readonly records: readonly TraceRecord[];
		readonly nextCursor?: TraceCursor;
	}>;
	tailCursor(): Promise<TraceCursor | undefined>;
}
```

持久化 exporter 可以采用 at-least-once，Store 以 `eventId` 做唯一键去重。cursor 由 Store 分配时，必须定义与 Hub cursor 的映射或使用统一 journal；不能假设内存 offset 在重启后仍有效。

审计级消费者应从 Store 读取并用 Hub 只追 live tail，使用与 12.3 相同的 snapshot-then-subscribe 原则完成切换。

## 13. 示例 Trace

模型一次请求 `search` 和 `read_docs`，执行 `search` 时 run 被取消：

```text
seq=1  agent.run.started
seq=2  tool.call.requested  exec=tex_A tool=search    ordinal=0
seq=3  tool.call.requested  exec=tex_B tool=read_docs ordinal=1
seq=4  tool.call.started    exec=tex_A queue=0.8ms
seq=5  tool.call.finished   exec=tex_A outcome=cancelled stage=cancellation
seq=6  tool.call.finished   exec=tex_B outcome=skipped   stage=cancellation
seq=7  agent.run.finished   outcome=cancelled
```

由此可以无歧义地判断：

- 两个调用都由模型请求；
- `search` 实际进入过 `execute()`；
- `read_docs` 从未开始执行；
- 两项均已闭合，没有“日志漏写导致状态未知”；
- 整个 run 以取消而非普通失败结束。

## 14. 测试与验收标准

### 14.1 生命周期测试

1. 无 tool call：只有 run started/finished，finished 为 success。
2. 单 tool success：requested → started → finished(success)，ID 全程一致。
3. 多 tool success：先产生全部 requested，再严格串行 started/finished。
4. tool not found：requested → finished(error/lookup)，没有 started。
5. invalid arguments：requested → finished(error/validation)，没有 started。
6. tool 返回 `isError: true`：finished(error/execution)。
7. tool 抛普通异常：finished(error/execution)，Agent 仍按现有规则生成 error ToolResult。
8. tool 执行中取消：当前项 cancelled，剩余项 skipped，run cancelled。
9. 第一项开始前取消：第一项 cancelled，剩余项 skipped，所有调用均无 started。
10. compact 替换 context 后，既有 Trace 仍完整存在。
11. follow-up 进入下一轮时复用同一个 runId，assistantTurnId 递增/变化。
12. 下一次独立 prompt 使用新的 runId，同一 Session 继续使用原 sessionId。

### 14.2 稳定性测试

1. Sink 的 `emit()` 每次都抛错，Agent 的最终消息和错误语义不变。
2. `onError` 抛错，Agent 仍正常完成。
3. circular、BigInt、超深对象和超大 result 不导致 Agent 失败。
4. wall clock 回拨时 `sequence` 仍有序，duration 不出现负数。
5. JSONL 中每行均可独立 `JSON.parse`。
6. 模拟 exporter 重试后可按 `eventId` 去重。
7. 超过 buffer 上限时按配置丢弃并正确增加 dropped 计数。

### 14.3 安全测试

1. 大小写和分隔符不同的敏感键均被替换。
2. 嵌套数组/对象中的敏感键被替换。
3. binary/image 不写入正文或 base64。
4. 默认错误事件不包含 stack。
5. 每个 tool 的 `none` / `metadata` override 生效。
6. 截断后的事件包含正确的长度和 truncated 标记。

### 14.4 订阅测试

1. `start: latest` 只收到订阅完成后的新事件。
2. `start: earliest_available` 按 cursor 顺序收到 ring 内全部匹配事件。
3. `start: after` 无缝产生 replay 后的 live 事件，不缺失、不重复。
4. 多个 Session/Run 交错 emit 时，cursor 全局严格递增，各 run 的 sequence 保持独立。
5. event type、session、run、tool 和 outcome 过滤使用维度间 AND、维度内 OR。
6. filter 不影响 JSONL Sink 保存完整事件。
7. 慢订阅者达到 buffer 上限时，默认只关闭该订阅，不影响 Agent、Sink 和其他订阅。
8. `drop_oldest` 会先产生准确的 TraceGap，不静默丢弃。
9. cursor 过期、跨 Hub 或格式非法时返回对应 typed error。
10. 订阅期间 ring 发生淘汰，不影响已经进入该订阅 buffer 的事件。
11. iterator.return()、close() 和 AbortSignal 都会移除订阅及 signal listener。
12. Hub dispose 会 settle 所有 pending next，并拒绝新订阅。
13. 一个下游 Sink throw 时，其他 Sink 和订阅仍收到同一 eventId。
14. SSE `id` 使用 cursor，data 中保留原 eventId，重连后可正确续订和去重。
15. 未授权用户不能通过 filter 或 cursor 订阅其他 Session。
16. 订阅端收到的 payload 已按 capture policy 脱敏，无法访问原始对象引用。

验收条件：以上测试全部通过，并且现有 Agent Core 测试在未配置 trace 时无需修改行为断言即可继续通过。

## 15. 实施拆分

### Phase 1：类型与内存链路

- 增加 `trace-types.ts`、`trace-recorder.ts` 和 `InMemoryTraceSink`；
- 为 Session/Agent 注入 no-op 或真实 Recorder；
- 完成 run 与 tool 三类事件埋点；
- 完成确定性 ID、时钟、顺序和取消测试。

### Phase 2：安全采集与 JSONL

- 增加 safe serializer、redactor 和 capture policy；
- 实现有界异步写队列；
- 实现 `JsonlTraceSink`、flush、轮转接缝和故障统计；
- 增加脱敏、截断、背压和坏 Sink 测试。

### Phase 3：事件 Hub 与订阅

- 实现 `TraceEventHub`、全局 cursor 和有界 replay ring；
- 实现 `TraceSource`、AsyncIterable subscription 和 filter；
- 实现每订阅者有界 buffer、overflow close 和 TraceGap；
- 完成 replay-to-live 原子切换、关闭清理和多 Sink 隔离测试；
- 在 Agent Service 层实现按 Session 授权的 SSE Adapter。

### Phase 4：展示与生态适配

- `ConsoleTraceSink`；
- 按 run/tool 展示的 CLI 或调试 UI；
- OpenTelemetry adapter；
- 可选 model call、compact、queue admission 和 tool 内部 child span 事件。

## 16. 后续扩展兼容性

后续新增事件只能追加新的 `type`，不得改变 schema version 1 现有字段的含义。消费者遇到未知事件类型必须忽略而不是失败。

以下扩展已预留但不属于 MVP：

- `model.call.started/finished`：token、首 token 延迟、provider error；
- `context.compact.started/finished`：compact 原因和 token 变化；
- `message.steer.accepted/rejected`、`message.follow_up.accepted/rejected`；
- tool retry：同一逻辑 call 下多个 execution attempt；
- 并发 tool：依靠 sequence、时间和 executionId，而非假设事件成对相邻；
- 跨进程传播：把 `runId` 映射到外部 trace ID，并由 adapter 管理传播格式。

## 17. 完成定义

当以下陈述同时成立时，本功能可视为完成：

- 给定任一 `runId`，可以列出模型请求过的全部 tool calls；
- 每个 call 可以明确判断是否真正执行，以及最终结果类别；
- 可以计算每个 call 的等待、执行和总耗时；
- 取消时当前与剩余 calls 都具有正确且唯一的终态；
- compact 后仍能保留完整调用事实；
- 默认日志不包含已知 secret 字段、binary 正文或 error stack；
- Sink 全面失败时，Agent 对调用方表现出的业务行为保持不变；
- JSONL 可以作为后续 CLI、UI 和遥测 adapter 的唯一输入，不需要再次改造 Agent 埋点。
- 多个消费者可以按 Session、Run、类型或 Tool 实时订阅同一 Trace 事实流；
- 订阅可以使用 cursor 在内存保留窗口内无缝 replay-to-live；
- 慢消费者和订阅断开不会阻塞 Agent，也不会影响其他消费者或持久化 Sink；
- 订阅发生 gap 或 cursor expired 时会显式报告，绝不伪装成完整 Trace；
- Web 后端可以把同一订阅安全桥接为支持断线续订的 SSE。
