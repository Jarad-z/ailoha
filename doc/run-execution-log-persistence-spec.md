# Agent Run Execution Log Persistence Spec

状态：Implemented v0.1  
适用范围：`@ailoha/agent-core`、`@ailoha/agent-service`  
依赖文档：[`tool-call-trace-spec.md`](./tool-call-trace-spec.md)、[`agent-service-runtime-spec.md`](./agent-service-runtime-spec.md)

## 1. 背景

Ailoha 已经具备 Run 和 Tool Call Trace，并提供 `InMemoryTraceSink`、`TraceEventHub` 与
`JsonlTraceSink`。当前 JSONL 只在测试中写入临时文件，生产服务没有稳定落盘目录；现有事件也主要
覆盖 Run 和 Tool，尚不能完整回答以下问题：

- 一次用户请求触发了多少轮 LLM 调用；
- 每轮 LLM 看到了多大的 Context；
- 模型在每轮选择了直接回答还是 Tool Call；
- Context 是否发生压缩，压缩前后规模如何；
- 一次 Run 是否形成了完整、可独立读取的持久化记录；
- HTTP Operation、Session、Run、LLM Call 和 Tool Call 之间如何关联。

本文定义一套按 Run 分区的本地 JSONL 执行日志。它补充现有 Tool Trace，不替代 Session Store、
Transcript Store 或产品 Operation 日志。

## 2. 术语与边界

### 2.1 对象层级

```text
Session：一个可持续对话的产品窗口
└─ Run：一次完整的顶层 Agent Loop
   ├─ Operation：创建或影响该 Run 的产品/API 操作
   ├─ LLM Call 1：一轮模型调用
   ├─ Tool Call 1..N：模型在某轮请求的工具执行
   ├─ LLM Call 2..N
   └─ Final Answer / Run Terminal State
```

### 2.2 Run 的精确定义

一次 `Agent.prompt()` 创建一个 Run。Run 从 `agent.run.started` 开始，在以下任一终态结束：

- `success`：Agent Loop 得到最终 Assistant Message；
- `error`：模型、Context、轮次或 Runtime 错误使 Run 失败；
- `cancelled`：用户或 Session 生命周期取消 Run。

Run 可以包含多次 LLM Call、多次 Tool Call，也可以包含运行期间接收的 steer/follow-up。Run 不是：

- 一次 LLM API 请求；
- 一次 Tool Call；
- 一个长期 Session；
- 一个产品级 Operation。

### 2.3 Operation 与 Run 的关系

产品 Operation 是一次控制面写操作：

```text
session.create       → 没有 runId
message.send(prompt) → 创建一个 runId
message.send(follow_up/steer) → 加入已有 runId
run.abort            → 影响已有 runId
session.compact      → 没有 runId
session.close        → 可能取消已有 runId
```

创建 Run 的首个 Operation ID 写入 `correlationId`。后续影响同一 Run 的 Operation 通过
`agent.message.admitted` 等事件记录自己的 `operationId`，不得覆盖首个 `correlationId`。

## 3. 目标

MVP 必须做到：

1. 每个 Run 形成一个可独立读取的 JSONL 文件。
2. 日志能够还原 Context → LLM → Tool → LLM → Final 的执行顺序。
3. 每个 Run、LLM Call 和 Tool Call 均有稳定 ID 和完整终态。
4. 每条事件是一行完整、可独立 `JSON.parse` 的 JSON。
5. 运行中的文件与正常完成的文件可以被明确区分。
6. 日志采集、脱敏或落盘失败不得改变 Agent 业务结果。
7. 默认日志足以定位流程和性能问题，但不保存隐藏思维链或未经脱敏的敏感内容。
8. SSE 实时 Trace 与 JSONL 使用同一份已冻结、已脱敏事件，不生成两套事实。
9. 服务可以按已授权的 `runId` 返回落盘 Trace。
10. 所有行为可以在无网络、无 API Key 的确定性 E2E 中验证，并至少有一个真实模型 HTTP E2E。

## 4. 非目标

MVP 不实现：

- 使用 Trace 恢复 Session 或重新执行 Run；
- Session、Transcript、Tool State 的持久化；
- 分布式 Trace 后端、OpenTelemetry Collector 或日志搜索集群；
- Token streaming 的逐 chunk 永久记录；
- 完整 Prompt、完整 Context 或模型隐藏思维链的默认落盘；
- 跨机器共享文件锁；
- 审计级不可抵赖存储；
- 复杂异常恢复策略。本版本只要求失败 Run 形成明确终态事件。

## 5. 核心设计决定

### 5.1 一个 Run 一个 JSONL 文件

推荐目录：

```text
data/
└─ traces/
   └─ 2026-09-12/
      └─ session_<id>/
         ├─ run_<id>.jsonl
         └─ run_<unfinished>.jsonl.part
```

原因：

- 一个文件天然对应一次完整 Agent Loop；
- 无需查询数据库即可复制、归档和人工检查；
- 不同 Session/Run 并发写入不同文件，避免共享追加文件争用；
- Run 完成后文件不可再追加，便于判断完整性；
- 单个文件体积受单次 Run 的最大轮次约束。

### 5.2 `.part` 表示非正常或尚未结束

Run 开始时创建：

```text
run_<id>.jsonl.part
```

写入并成功 flush `agent.run.finished` 后，原子重命名为：

```text
run_<id>.jsonl
```

进程崩溃后遗留的 `.part` 文件表示 Trace 不完整。不得在恢复时伪造
`agent.run.finished`；诊断工具可以把它标记为 `incomplete/process_crash`。

### 5.3 Trace 与 Session 状态分离

```text
Session Store     → 恢复对话、Context、摘要和 Tool State
Transcript Store  → 产品聊天记录
Run Trace Store   → 调试、审计和性能分析
Operation Log     → 产品控制操作和幂等结果
```

Trace 允许截断和脱敏，因此不能作为 Session 恢复数据源。Session 持久化必须使用独立 Spec 和 Store。

### 5.4 一套事件，多种 Sink

```text
Agent / ContextManager
  → TraceRecorder
     → TraceEventHub
        ├─ SSE Subscribers
        ├─ InMemoryTraceSink（测试/短期回放）
        └─ PartitionedJsonlTraceSink（按 Run 落盘）
```

`PartitionedJsonlTraceSink` 只负责路由和写文件，不重新采集、修改或脱敏事件。

## 6. 日志粒度

### 6.1 生产默认级别

| 级别 | 内容 | 默认 |
|---|---|---|
| `summary` | Run 开始/结束、状态、总耗时、调用次数、Token/成本汇总 | 否 |
| `execution` | Context 元数据、每轮 LLM、每次 Tool、压缩和 Run 生命周期 | 是 |
| `debug` | 在 execution 基础上增加脱敏后的 Prompt/Response 预览 | 否 |

`execution` 是本 Spec 的标准验收级别。

### 6.2 不记录逐 Token 事件

流式 LLM 响应只在内存/UI 中逐 chunk 传输。持久化日志在一轮完成后聚合为一个
`llm.call.finished`，避免日志量与输出 Token 数线性增长。

### 6.3 不记录隐藏思维链

允许记录：

- `decisionType = final | tool_calls`；
- `decisionSummary`：短、面向行为的决策说明；
- Thinking block 的数量和字节数；
- Provider stop reason。

禁止默认记录模型隐藏思维链全文。若 Provider 返回可展示的 reasoning summary，它也必须经过和
普通文本相同的脱敏与长度限制。

## 7. 公共事件 Envelope

沿用现有 `TraceEventBase`，增加可选的层级字段：

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

  readonly round?: number;
  readonly llmCallId?: string;
  readonly assistantTurnId?: string;
  readonly toolExecutionId?: string;
  readonly operationId?: string;

  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}
```

约束：

- `sequence` 在一个 Run 内从 1 开始严格递增；
- `eventId` 全局唯一，用于持久化重试去重；
- `round` 从 1 开始，表示该 Run 中的 LLM 决策轮次；
- `llmCallId` 在 `llm.call.started/finished` 之间保持一致；
- `assistantTurnId` 仅在成功解析出 Assistant Message 后存在；
- Tool 字段继续遵守现有 Tool Trace Spec；
- 所有事件必须在 emit 前冻结为 JSON 可序列化快照。

## 8. 事件集合

```ts
type TraceEventType =
  | "agent.run.started"
  | "agent.message.admitted"
  | "context.prepared"
  | "context.compact.started"
  | "context.compact.finished"
  | "llm.call.started"
  | "llm.call.finished"
  | "tool.call.requested"
  | "tool.call.started"
  | "tool.call.finished"
  | "agent.run.finished";
```

其中 `agent.run.*` 与 `tool.call.*` 复用现有实现。新增事件定义如下。

### 8.1 `agent.message.admitted`

记录 Run 运行期间收到的 steer/follow-up：

```ts
interface AgentMessageAdmittedEvent extends TraceEventBase {
  readonly type: "agent.message.admitted";
  readonly operationId?: string;
  readonly delivery: "steer" | "follow_up";
  readonly message: CapturedValue;
}
```

初始 prompt 已由 `agent.run.started.inputMessageCount` 和 `correlationId` 关联，不重复生成 admitted 事件。

### 8.2 `context.prepared`

在 `ContextManager.beginRun()` 成功提交本轮输入后产生：

```ts
interface ContextPreparedEvent extends TraceEventBase {
  readonly type: "context.prepared";
  readonly systemPromptCount: number;
  readonly toolCount: number;
  readonly historyMessageCount: number;
  readonly inputMessageCount: number;
  readonly totalMessageCount: number;
  readonly estimatedTokens?: number;
  readonly contextSha256: string;
}
```

`contextSha256` 对规范化后的 Context 计算，但默认不保存 Context 全文。

### 8.3 `context.compact.started`

```ts
interface ContextCompactStartedEvent extends TraceEventBase {
  readonly type: "context.compact.started";
  readonly compactId: string;
  readonly reason: "before_llm" | "llm_error" | "manual";
  readonly messageCount: number;
  readonly estimatedTokens?: number;
}
```

### 8.4 `context.compact.finished`

```ts
interface ContextCompactFinishedEvent extends TraceEventBase {
  readonly type: "context.compact.finished";
  readonly compactId: string;
  readonly outcome: "changed" | "unchanged" | "error" | "cancelled";
  readonly durationMs: number;
  readonly beforeMessageCount: number;
  readonly afterMessageCount?: number;
  readonly beforeTokens?: number;
  readonly afterTokens?: number;
  readonly error?: CapturedError;
}
```

### 8.5 `llm.call.started`

在调用 `ModelRunner.run()` 前产生：

```ts
interface LlmCallStartedEvent extends TraceEventBase {
  readonly type: "llm.call.started";
  readonly round: number;
  readonly llmCallId: string;
  readonly model: {
    readonly provider?: string;
    readonly id: string;
  };
  readonly messageCount: number;
  readonly estimatedInputTokens?: number;
  readonly toolCount: number;
  readonly request?: CapturedValue; // 只在 debug 级别提供脱敏预览
}
```

### 8.6 `llm.call.finished`

```ts
interface LlmCallFinishedEvent extends TraceEventBase {
  readonly type: "llm.call.finished";
  readonly round: number;
  readonly llmCallId: string;
  readonly assistantTurnId?: string;
  readonly outcome: "success" | "error" | "cancelled";
  readonly durationMs: number;
  readonly stopReason?: string;
  readonly decisionType?: "final" | "tool_calls";
  readonly toolCallCount?: number;
  readonly textBlockCount?: number;
  readonly thinkingBlockCount?: number;
  readonly decisionSummary?: CapturedValue;
  readonly response?: CapturedValue; // 只在 debug 级别提供脱敏预览
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly totalTokens: number;
    readonly costUsd?: number;
  };
  readonly error?: CapturedError;
}
```

`decisionType` 从结构化 Assistant Message 推导：存在 Tool Call 时为 `tool_calls`，否则为 `final`。
不得通过保存隐藏思维链来推导该字段。

## 9. 标准事件顺序

### 9.1 直接回答

```text
1 agent.run.started
2 context.prepared
3 llm.call.started       round=1
4 llm.call.finished      round=1 decisionType=final
5 agent.run.finished     outcome=success
```

### 9.2 单工具闭环

```text
 1 agent.run.started
 2 context.prepared
 3 llm.call.started       round=1
 4 llm.call.finished      round=1 decisionType=tool_calls
 5 tool.call.requested
 6 tool.call.started
 7 tool.call.finished     outcome=success
 8 llm.call.started       round=2
 9 llm.call.finished      round=2 decisionType=final
10 agent.run.finished     outcome=success
```

### 9.3 多工具、多轮与 Follow-up

同一 Assistant Message 可以产生多个按 ordinal 排列的 Tool Call。每个 Tool Call 必须完成自己的
requested → started? → finished 生命周期。运行期间加入的 follow-up/steer 使用
`agent.message.admitted`，继续沿用同一 `runId`，不得创建第二个 Run 文件。

### 9.4 最大轮次终止

达到 `maxTurns` 时，不得产生超出限制的 `llm.call.started`。最后一条必须是：

```json
{
  "type": "agent.run.finished",
  "outcome": "error",
  "error": {
    "name": "AgentTurnLimitError",
    "code": "AGENT_TURN_LIMIT"
  }
}
```

## 10. JSONL 示例

以下字段为简化示例；真实事件仍需包含完整 Envelope：

```jsonl
{"schemaVersion":1,"eventId":"evt_1","sequence":1,"type":"agent.run.started","sessionId":"ses_1","runId":"run_1","correlationId":"op_1","timeUnixMs":1789219600000,"inputMessageCount":1,"model":{"provider":"deepseek","id":"deepseek-v4-flash"}}
{"schemaVersion":1,"eventId":"evt_2","sequence":2,"type":"context.prepared","sessionId":"ses_1","runId":"run_1","timeUnixMs":1789219600001,"historyMessageCount":0,"inputMessageCount":1,"totalMessageCount":1,"toolCount":3,"systemPromptCount":1,"contextSha256":"sha256:..."}
{"schemaVersion":1,"eventId":"evt_3","sequence":3,"type":"llm.call.started","sessionId":"ses_1","runId":"run_1","round":1,"llmCallId":"llm_1","timeUnixMs":1789219600002,"model":{"provider":"deepseek","id":"deepseek-v4-flash"},"messageCount":1,"toolCount":3}
{"schemaVersion":1,"eventId":"evt_4","sequence":4,"type":"llm.call.finished","sessionId":"ses_1","runId":"run_1","round":1,"llmCallId":"llm_1","assistantTurnId":"turn_1","timeUnixMs":1789219601000,"outcome":"success","durationMs":998,"stopReason":"toolUse","decisionType":"tool_calls","toolCallCount":1,"usage":{"inputTokens":420,"outputTokens":38,"totalTokens":458}}
{"schemaVersion":1,"eventId":"evt_5","sequence":5,"type":"tool.call.requested","sessionId":"ses_1","runId":"run_1","assistantTurnId":"turn_1","toolExecutionId":"exec_1","toolCallId":"call_1","toolName":"calculator","ordinal":0,"attempt":1,"timeUnixMs":1789219601001,"arguments":{"mode":"redacted","value":{"expression":"12345 * 6789"}}}
{"schemaVersion":1,"eventId":"evt_6","sequence":6,"type":"tool.call.started","sessionId":"ses_1","runId":"run_1","assistantTurnId":"turn_1","toolExecutionId":"exec_1","toolCallId":"call_1","toolName":"calculator","ordinal":0,"attempt":1,"timeUnixMs":1789219601002,"queueDurationMs":1}
{"schemaVersion":1,"eventId":"evt_7","sequence":7,"type":"tool.call.finished","sessionId":"ses_1","runId":"run_1","assistantTurnId":"turn_1","toolExecutionId":"exec_1","toolCallId":"call_1","toolName":"calculator","ordinal":0,"attempt":1,"timeUnixMs":1789219601003,"outcome":"success","totalDurationMs":2,"executionDurationMs":1,"result":{"mode":"redacted","value":{"result":83810205}}}
{"schemaVersion":1,"eventId":"evt_8","sequence":8,"type":"llm.call.started","sessionId":"ses_1","runId":"run_1","round":2,"llmCallId":"llm_2","timeUnixMs":1789219601004,"model":{"provider":"deepseek","id":"deepseek-v4-flash"},"messageCount":3,"toolCount":3}
{"schemaVersion":1,"eventId":"evt_9","sequence":9,"type":"llm.call.finished","sessionId":"ses_1","runId":"run_1","round":2,"llmCallId":"llm_2","assistantTurnId":"turn_2","timeUnixMs":1789219601800,"outcome":"success","durationMs":796,"stopReason":"stop","decisionType":"final","toolCallCount":0,"usage":{"inputTokens":510,"outputTokens":25,"totalTokens":535}}
{"schemaVersion":1,"eventId":"evt_10","sequence":10,"type":"agent.run.finished","sessionId":"ses_1","runId":"run_1","correlationId":"op_1","timeUnixMs":1789219601801,"outcome":"success","durationMs":1801,"assistantTurnCount":2,"toolCallCount":1}
```

## 11. Payload、脱敏与截断

### 11.1 默认采集策略

| 数据 | 默认模式 | 说明 |
|---|---|---|
| Run/LLM/Tool 元数据 | `full` | ID、类型、状态、计数和耗时不是内容载荷 |
| 用户消息 | `metadata` | 字节数、哈希；不保存全文 |
| Context | `metadata` | 消息数、Token 估算、哈希 |
| LLM request/response | `none` | debug 时才启用 `redacted` |
| Tool arguments | `redacted` | 最大 4 KiB |
| Tool result | `redacted` | 最大 4 KiB |
| Decision summary | `redacted` | 最大 1 KiB |
| Error | `message` | 默认不保存 stack |

### 11.2 敏感键

以下键名大小写不敏感并递归脱敏：

```text
authorization
api_key
apiKey
password
secret
token
access_token
refresh_token
cookie
set-cookie
```

值统一替换为 `[REDACTED]`。自定义 Tool 可以追加敏感键，但不能关闭平台级内置规则。

### 11.3 截断

载荷超过 `maxValueBytes` 时必须记录：

```ts
interface CapturedValue {
  readonly mode: "none" | "metadata" | "redacted" | "full";
  readonly value?: unknown;
  readonly byteLength?: number;
  readonly sha256?: string;
  readonly truncated?: boolean;
  readonly originalByteLength?: number;
}
```

截断只影响 Trace，不得改变传给模型或 Tool 的真实数据。

## 12. 持久化 Sink

### 12.1 接口

```ts
interface PartitionedJsonlTraceSinkOptions {
  readonly rootDir: string;
  readonly maxPendingEvents?: number;
  readonly fsyncOnRunFinish?: boolean;
  readonly onError?: (error: Error) => void;
}

class PartitionedJsonlTraceSink implements TraceSink {
  emit(event: TraceEvent): void;
  flush(): Promise<void>;
  dispose(): Promise<void>;
  stats(): TraceSinkStats & {
    readonly openRunFiles: number;
    readonly completedRunFiles: number;
    readonly incompleteRunFiles: number;
  };
}
```

### 12.2 写入规则

1. `agent.run.started` 首次出现时计算并固定 Run 文件路径。
2. 同一 Run 的事件进入该 Run 独立的 Promise 写队列。
3. `emit()` 不等待磁盘 I/O，也不向 Agent 抛出 Sink 错误。
4. 每条记录写为 `JSON.stringify(event) + "\n"`。
5. `agent.run.finished` 写入后 flush；若配置 `fsyncOnRunFinish`，再执行 fsync。
6. 对文件执行第 14 节完整性检查；通过后才把 `.jsonl.part` 原子重命名为 `.jsonl`。
7. 完成文件不可再次追加；后续同 runId 事件视为 Sink 写入错误。
8. `dispose()` 等待所有已接受写入，关闭句柄，但不删除 `.part`。

### 12.3 路径安全

`sessionId` 和 `runId` 必须先经过现有 ID 校验，并再次验证最终 `resolve()` 路径位于 `rootDir` 内。
禁止直接把未经校验的 HTTP path 参数拼接为磁盘路径。

### 12.4 背压

超过 `maxPendingEvents` 后：

- 新事件可以被丢弃；
- `droppedEvents` 必须递增；
- 调用 `onError`，但不得影响 Agent；
- Run 文件保持 `.part`，不得伪装为完整 `.jsonl`。

## 13. 服务接入

### 13.1 启动配置

```dotenv
TRACE_ENABLED=1
TRACE_DIR=./data/traces
TRACE_LEVEL=execution
TRACE_CAPTURE_ARGUMENTS=redacted
TRACE_CAPTURE_RESULTS=redacted
TRACE_MAX_VALUE_BYTES=4096
TRACE_FSYNC_ON_RUN_FINISH=0
TRACE_RETENTION_DAYS=30
```

服务启动时组装：

```ts
const fileSink = new PartitionedJsonlTraceSink({
  rootDir: config.traceDir,
  fsyncOnRunFinish: config.fsyncOnRunFinish,
});

const traceHub = new TraceEventHub({ sinks: [fileSink] });
const runtime = new AgentServiceRuntime({ traceHub, ...options });
```

如果 `TRACE_ENABLED=0`，使用 no-op Trace 或关闭持久化 Sink，但产品环境建议始终保留 `summary` 级别。

### 13.2 查询接口

新增：

```http
GET /v1/runs/:runId/trace
Accept: application/x-ndjson
```

语义：

- 先通过 Service Run Registry 验证 Run 存在及 owner 权限；
- 已完成 Run 返回 `.jsonl`；
- 运行中 Run 返回 `409 run_not_finished`，客户端继续使用 Session SSE；
- 文件不存在返回 `404 trace_not_found`；
- 不允许通过请求参数提供任意文件路径；
- 响应使用流式读取，不把整个文件一次性加载进内存。

保留现有实时接口：

```http
GET /v1/sessions/:sessionId/trace
Accept: text/event-stream
```

SSE 用于在线观察；Run JSONL 用于完成后的稳定读取。

### 13.3 Operation 日志

产品 Operation 不按 Run 文件存储。建议单独使用：

```text
data/operations/2026-09-12.jsonl
```

Operation 日志至少包含 `operationId/type/ownerId/sessionId/runId/status/durationMs/errorCode`。没有
`runId` 的 `session.create/session.compact/session.close` 也能独立记录。

## 14. 完整性约束

一个正常完成的 `.jsonl` 文件必须满足：

1. 第一条事件是唯一的 `agent.run.started`；
2. 最后一条事件是唯一的 `agent.run.finished`；
3. 全部事件的 `sessionId/runId` 相同；
4. `sequence` 从 1 开始严格递增且不重复；
5. 每个 `llm.call.started` 恰好对应一个相同 `llmCallId` 的 `llm.call.finished`；
6. 每个 `tool.call.requested` 恰好对应一个相同 `toolExecutionId` 的 `tool.call.finished`；
7. `tool.call.started` 如果存在，必须位于 requested 与 finished 之间；
8. Run finish 的 `assistantTurnCount/toolCallCount` 与文件内事实一致；
9. `success` Run 的最后一次成功 LLM Call 必须为 `decisionType=final`；
10. 任何明文敏感 canary 均不得出现在文件中；
11. 文件中每一行必须能单独 `JSON.parse`；
12. 文件名为 `.jsonl` 表示上述完整性检查已通过；否则保留 `.part`。

## 15. 保留、轮转与清理

MVP 默认：

- `TRACE_RETENTION_DAYS=30`；
- 只删除超过保留期的完整 `.jsonl`；
- `.part` 至少保留 7 天供崩溃诊断；
- 清理任务只在服务启动后异步运行，不阻塞监听端口；
- 删除前必须验证目标路径位于配置的 `TRACE_DIR`；
- 清理失败只计日志和指标，不影响 Agent。

单 Run 文件不再按大小轮转。若一个 Run 可能异常膨胀，应依靠 `maxTurns`、载荷截断和
`maxPendingEvents` 控制。

## 16. 指标

至少暴露：

```text
trace_events_accepted_total
trace_events_dropped_total
trace_write_errors_total
trace_run_files_open
trace_run_files_completed_total
trace_run_files_incomplete_total
trace_flush_duration_ms
```

指标不得使用 `sessionId/runId` 作为 label，避免高基数。

## 17. 测试方案

### 17.1 单元测试

1. Event 能独立 JSON 序列化。
2. sessionId/runId 路径校验阻止目录穿越。
3. 同一 Run 写入严格有序。
4. 两个 Run 并发写入不同文件且不串事件。
5. 敏感字段递归脱敏。
6. 大载荷正确截断并保留 SHA-256 和原始大小。
7. finished 后拒绝继续追加。
8. Sink 错误只增加统计，不向 Agent 抛出。

### 17.2 确定性 E2E

至少验证：

- 直接回答生成 5 个标准事件；
- calculator 单工具闭环生成 10 个标准事件；
- search → calculator 的 LLM round 为 1、2、3；
- 纯对话追问产生两个不同 Run 文件但属于同一 Session；
- 带工具追问的第二个 Run 可以使用第一个 Run 提交的历史；
- 两个 Session 并发时目录、内容和 ID 完全隔离；
- Context 压缩产生配对的 compact 事件；
- 最大轮次终止时没有多余 LLM started 事件；
- 每个完成文件通过第 14 节全部完整性约束。

### 17.3 真实模型 HTTP E2E

流程：

```text
启动服务
→ 创建 Profile
→ 创建 Session
→ 订阅 SSE Trace
→ 发送要求使用 calculator 的消息
→ 等待 Run 成功
→ GET /v1/runs/:runId/trace
→ 比较 SSE 与 JSONL 的 eventId/sequence/type
→ 验证最终答案
→ 关闭服务
```

断言：

- 模型真实调用一次 calculator；
- JSONL 至少包含两次 LLM Call；
- SSE 与 JSONL 事件集合一致；
- 最终结果包含正确数字；
- 服务退出码为 0；
- 文件中不包含 API Key。

## 18. 实施阶段

### Phase 1：补齐执行事件

- 扩展 `TraceEventType`；
- 在 Context prepare/compact 位置埋点；
- 在每次 `ModelRunner.run()` 前后埋点；
- 扩展 Trace 完整性测试。

### Phase 2：按 Run 落盘

- 实现 `PartitionedJsonlTraceSink`；
- 实现 `.part → .jsonl` 生命周期；
- 实现路径安全、队列、flush、fsync 和统计；
- 增加并发与故障测试。

### Phase 3：服务接入与读取

- 从环境变量加载 Trace 配置；
- 将文件 Sink 接入 Service 的 `TraceEventHub`；
- 增加 `GET /v1/runs/:runId/trace`；
- 增加权限和流式读取测试。

### Phase 4：真实模型验收

- 扩展现有 DeepSeek HTTP E2E；
- 同时比较 SSE、落盘文件和 Transcript；
- 保存不含敏感内容的测试执行摘要。

## 19. 完成定义

以下条件全部满足后，本 Spec 可标记为 Implemented：

- 每个 Agent Run 均生成独立 `.jsonl`；
- 每个正常完成文件都以 run.started 开始、run.finished 结束；
- Context、LLM、Tool 和 Run 生命周期完整；
- 多轮、多工具和 Follow-up 可以按 ID/sequence 还原；
- 同一 Session 的不同 Run 文件彼此独立；
- 不同 Session 的路径和事件不串线；
- 敏感信息默认脱敏，大载荷默认截断；
- Trace 写入失败不改变 Agent Run 结果；
- SSE 与落盘 JSONL 使用同一事件事实；
- 已授权用户可以通过 runId 读取完成 Trace；
- 确定性 E2E、全仓库测试和真实模型 HTTP E2E 全部通过。
