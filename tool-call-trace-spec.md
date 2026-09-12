# Tool Call Trace / Execution Log Spec

状态：Draft v0.1

适用范围：`@ailoha/agent-core` 及其上层 Session 运行时

首个实现目标：本地结构化事件流 + JSONL 文件 Sink

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

## 3. 非目标

MVP 不实现：

- 分布式跨服务 tracing 后端；
- 完整 prompt、模型输出或 token streaming 记录；
- tool 自动重试；`attempt` 字段只为未来兼容预留；
- tool 并发调度；仍遵守当前按 assistant 输出顺序串行执行的规则；
- 用 Trace 恢复或重放 Agent run；
- 通用 hook/plugin 系统；
- 在 Agent Core 内提供日志搜索数据库或 Web UI；
- 保证进程崩溃前尚未落盘的内存事件一定持久化。

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

## 5. 标识与关联

| 字段 | 生成方 | 生命周期 | 用途 |
| --- | --- | --- | --- |
| `sessionId` | Session | Session 生命周期 | 关联同一 Session 的多个 run |
| `runId` | Agent | 每次顶层 `prompt()` | 一次完整 ReAct + follow-up run |
| `assistantTurnId` | Agent | 每次成功取得 assistant message | 关联同一次模型输出中的多个 tool calls |
| `toolCallId` | 模型 Provider | Provider tool call | 对应消息协议中的 `ToolCall.id` |
| `toolExecutionId` | Agent | 每个 observed tool call | Trace 内部稳定主键 |
| `eventId` | TraceRecorder | 每个事件 | 持久化重试时去重 |
| `sequence` | TraceRecorder | run 内递增 | 确定同一 run 的严格事件顺序 |
| `correlationId` | 可选，由调用方传入 | 外部请求生命周期 | 关联 HTTP request、job 或产品任务 |

约束：

- `toolCallId` 不得作为 Trace 主键。不同 Provider 或不同模型调用可能复用它。
- `toolExecutionId` 在 `tool.call.requested` 时生成，并在后续 started/finished 事件中保持不变。
- `sequence` 从 1 开始，在同一 `runId` 内严格递增且不重复。
- ID 默认使用 UUIDv7 或具有相同排序与唯一性能力的实现；测试必须允许注入确定性 ID generator。

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
- 每次 `agent.prompt()` 创建 run-local recorder scope 和 `runId`。
- `correlationId` 和 run 级 attributes 由 `prompt()` 的第二个参数传入，不能固定在 Session 配置中，否则同一 Session 的多个外部请求无法正确区分。
- 未配置 `trace` 时使用 no-op recorder，不应在业务路径中出现重复的 `if (trace)` 分支。
- `Session.dispose()` 尝试 flush/dispose Sink，但默认不因遥测失败而把一次已成功的 Agent run 改成失败。
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

## 11. 故障隔离与背压

Trace 属于观察路径，默认采用 best-effort：

- `TraceRecorder.emit()` 对 Agent 必须表现为同步、无 throw；
- Sink 内部可以异步落盘或发送，但必须自行排队；
- Sink 抛出的同步异常由 Recorder 捕获并传给 `onError`；
- `onError` 自身抛错也必须被吞掉，不能递归产生 Trace 事件；
- 异步 Sink 缓冲区必须有上限和明确的 overflow 策略；默认 `drop_newest`；
- Sink 必须统计 `acceptedEvents`、`droppedEvents`、`writeErrors`，供 dispose 后诊断；
- 不向同一个失败 Sink 写 `trace.dropped` 事件，否则可能递归失败；
- 默认模式下 flush 失败不改变 run outcome；严格持久化模式未来可由宿主应用在 Core 外实现。

“不影响业务”不等于静默丢失。发生 drop 或 write error 时，`onError` 至少在每个错误 burst 首次触发一次，并包含累计丢失数量。

## 12. 示例 Trace

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

## 13. 测试与验收标准

### 13.1 生命周期测试

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

### 13.2 稳定性测试

1. Sink 的 `emit()` 每次都抛错，Agent 的最终消息和错误语义不变。
2. `onError` 抛错，Agent 仍正常完成。
3. circular、BigInt、超深对象和超大 result 不导致 Agent 失败。
4. wall clock 回拨时 `sequence` 仍有序，duration 不出现负数。
5. JSONL 中每行均可独立 `JSON.parse`。
6. 模拟 exporter 重试后可按 `eventId` 去重。
7. 超过 buffer 上限时按配置丢弃并正确增加 dropped 计数。

### 13.3 安全测试

1. 大小写和分隔符不同的敏感键均被替换。
2. 嵌套数组/对象中的敏感键被替换。
3. binary/image 不写入正文或 base64。
4. 默认错误事件不包含 stack。
5. 每个 tool 的 `none` / `metadata` override 生效。
6. 截断后的事件包含正确的长度和 truncated 标记。

验收条件：以上测试全部通过，并且现有 Agent Core 测试在未配置 trace 时无需修改行为断言即可继续通过。

## 14. 实施拆分

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

### Phase 3：展示与生态适配

- `ConsoleTraceSink`；
- 按 run/tool 展示的 CLI 或调试 UI；
- OpenTelemetry adapter；
- 可选 model call、compact、queue admission 和 tool 内部 child span 事件。

## 15. 后续扩展兼容性

后续新增事件只能追加新的 `type`，不得改变 schema version 1 现有字段的含义。消费者遇到未知事件类型必须忽略而不是失败。

以下扩展已预留但不属于 MVP：

- `model.call.started/finished`：token、首 token 延迟、provider error；
- `context.compact.started/finished`：compact 原因和 token 变化；
- `message.steer.accepted/rejected`、`message.follow_up.accepted/rejected`；
- tool retry：同一逻辑 call 下多个 execution attempt；
- 并发 tool：依靠 sequence、时间和 executionId，而非假设事件成对相邻；
- 跨进程传播：把 `runId` 映射到外部 trace ID，并由 adapter 管理传播格式。

## 16. 完成定义

当以下陈述同时成立时，本功能可视为完成：

- 给定任一 `runId`，可以列出模型请求过的全部 tool calls；
- 每个 call 可以明确判断是否真正执行，以及最终结果类别；
- 可以计算每个 call 的等待、执行和总耗时；
- 取消时当前与剩余 calls 都具有正确且唯一的终态；
- compact 后仍能保留完整调用事实；
- 默认日志不包含已知 secret 字段、binary 正文或 error stack；
- Sink 全面失败时，Agent 对调用方表现出的业务行为保持不变；
- JSONL 可以作为后续 CLI、UI 和遥测 adapter 的唯一输入，不需要再次改造 Agent 埋点。
