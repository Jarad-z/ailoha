# Tool Call Trace / Event Subscription Test Plan

状态：Draft v0.1  
被测规格：`tool-call-trace-spec.md`  
关联规格：`agent-service-runtime-spec.md`  
默认测试框架：Vitest  
测试目标包：`@ailoha/agent-core`、未来的 `@ailoha/agent-service`

## 1. 测试目标

本测试计划验证 Tool Call Trace、Execution Log、TraceEventHub 和 Web SSE Adapter 满足以下核心性质：

1. 每个 Agent Run 有唯一、稳定且可关联的 `runId`。
2. 每个 observed tool call 从 requested 到唯一终态完整闭合。
3. Trace 顺序不改变现有 Agent 消息顺序和执行语义。
4. lookup、validation、execution、cancellation 和 skipped 可以无歧义区分。
5. Sink、序列化、脱敏或订阅失败不影响 Agent 业务结果。
6. 多个订阅者可以独立消费同一事件流。
7. replay-to-live 不丢事件、不重复事件。
8. cursor、eventId 和 run-local sequence 各自承担正确职责。
9. 慢消费者不会阻塞 Agent、其他订阅者或持久化 Sink。
10. SSE 断线续订、权限过滤和资源清理行为确定。

## 2. 测试边界

### 2.1 本计划覆盖

- `TraceRecorder`；
- run 和 tool lifecycle instrumentation；
- capture/redaction/safe serialization；
- `InMemoryTraceSink`；
- `JsonlTraceSink`；
- `TraceEventHub`；
- `TraceSubscription`；
- Hub cursor 和 replay ring；
- 多 Sink fan-out；
- Agent Service 的 Trace SSE Adapter；
- abort、compact、follow-up、steer 与 Trace 的交互。

### 2.2 本计划不覆盖

- Provider SDK 自身的正确性；
- 第三方 OpenTelemetry 后端；
- 跨机器的分布式 trace propagation；
- Tool 操作系统级沙箱；
- 进程崩溃前未写入磁盘事件的恢复；
- Web UI 视觉展示；
- 未进入本 Spec 的 token streaming。

## 3. 测试分层与建议文件

```text
packages/agent-core/test/
├─ trace-recorder.test.ts
├─ trace-agent-lifecycle.test.ts
├─ trace-capture.test.ts
├─ trace-event-hub.test.ts
├─ trace-subscription-model.test.ts
├─ trace-jsonl-sink.test.ts
└─ trace-session-lifecycle.test.ts

packages/agent-service/test/
├─ trace-sse.test.ts
├─ trace-authorization.test.ts
└─ trace-service-integration.test.ts
```

职责划分：

| 文件 | 主要职责 |
| --- | --- |
| `trace-recorder.test.ts` | ID、sequence、duration、事件冻结、Sink 隔离 |
| `trace-agent-lifecycle.test.ts` | Agent run/tool 事件顺序和 outcome |
| `trace-capture.test.ts` | 脱敏、截断、安全序列化和 capture policy |
| `trace-event-hub.test.ts` | cursor、ring、filter、fan-out 和 Hub 生命周期 |
| `trace-subscription-model.test.ts` | seeded 随机命令序列与订阅状态机不变量 |
| `trace-jsonl-sink.test.ts` | JSONL 原子行、flush、错误、轮转接缝 |
| `trace-session-lifecycle.test.ts` | Sink ownership、Session/Runtime dispose |
| `trace-sse.test.ts` | SSE frame、Last-Event-ID、重连、heartbeat、disconnect |
| `trace-authorization.test.ts` | owner/session 边界和过滤器注入防护 |
| `trace-service-integration.test.ts` | Service Run ID、correlationId 与 Trace 关联 |

不要把所有场景继续堆入现有 `agent.test.ts`。Agent 原有测试保留为业务行为回归；新的 Trace 文件专门断言观察路径。

## 4. 测试基础设施

### 4.1 DeterministicTraceClock

禁止依赖真实时间或 `sleep()`：

```ts
class DeterministicTraceClock implements TraceClock {
	wallMs = 1_789_123_456_000;
	monotonicMs = 0;

	nowUnixMs(): number {
		return this.wallMs;
	}

	nowMonotonicMs(): number {
		return this.monotonicMs;
	}

	advance(ms: number): void {
		this.wallMs += ms;
		this.monotonicMs += ms;
	}
}
```

单独提供 `moveWallClockBack(ms)`，验证 wall clock 回拨不会产生负 duration。

### 4.2 Deterministic ID Generator

按命名空间产生可读 ID：

```text
run_001, run_002
turn_001, turn_002
tex_001, tex_002
evt_001, evt_002
sub_001, sub_002
```

断言不得依赖 UUID 实现细节。生产默认 ID 只做格式和非空测试；顺序测试全部使用注入 generator。

### 4.3 ScriptedRunner

沿用当前测试中的 scripted model runner，并扩展：

- 每一步可以返回 assistant message；
- 可以返回 tool calls；
- 可以等待 `Deferred`；
- 可以读取 signal；
- 可以返回 provider error/aborted；
- 保存每次收到的 context snapshot。

所有并发和取消测试使用 Deferred/barrier 精确控制阶段，不使用时间猜测。

### 4.4 Scripted Tool

至少提供：

```ts
toolSuccess(result)
toolErrorResult(message)
toolThrows(error)
toolWaits(started, release)
toolIgnoresAbort(release)
```

Tool fixture 必须记录：

- execute 调用次数；
- 调用顺序；
- 接收的 `sessionId`；
- 接收的 signal；
- dispose 调用次数。

### 4.5 Recording Sink

提供同步、无复制语义的测试 Sink：

```ts
class RecordingTraceSink implements TraceSink {
	readonly events: TraceEvent[] = [];
	emit(event: TraceEvent): void {
		this.events.push(event);
	}
}
```

另外提供：

- `ThrowingSink`：每次 emit/flush/dispose 可配置抛错；
- `ReentrantSink`：收到指定事件时触发测试动作，例如 abort；
- `DeferredSink`：测试异步写队列和 flush；
- `MutatingSink`：尝试修改 frozen event，验证其他消费者不受影响。

### 4.6 Event Builders

Hub 单元测试不启动 Agent，而使用最小合法 `TraceEvent` builder：

```ts
runStarted(overrides)
runFinished(overrides)
toolRequested(overrides)
toolStarted(overrides)
toolFinished(overrides)
```

Builder 默认产生合法且冻结的事件。非法 envelope 测试使用显式 cast，不能污染普通 fixture。

### 4.7 通用断言 Helper

```ts
expectStrictRunSequence(events, runId)
expectToolExecutionClosed(events, toolExecutionId)
expectAllRequestedBeforeFirstStarted(events, assistantTurnId)
expectNoStarted(events, toolExecutionId)
expectNoSecret(value, secret)
expectFrozenDeep(value)
expectSameBusinessResult(withTrace, withoutTrace)
```

`expectToolExecutionClosed` 必须验证：

- 恰好一个 requested；
- started 为 0 或 1；
- 恰好一个 finished；
- 三者 `sessionId/runId/assistantTurnId/toolExecutionId/toolCallId/toolName/ordinal/attempt` 一致；
- finished outcome 与是否 started 的组合合法。

## 5. 全局不变量

所有相关测试除了场景自身断言外，还应复用下列不变量。

### INV-001：Run 闭合

一次已开始且未模拟进程崩溃的 Run：

```text
count(agent.run.started)  = 1
count(agent.run.finished) = 1
```

### INV-002：Tool 闭合

每个 `tool.call.requested` 必须有且只有一个同 `toolExecutionId` 的 `tool.call.finished`。

### INV-003：Started 可选且唯一

每个 Tool Execution 的 started 数量只能为 0 或 1，且顺序必须是：

```text
requested < started? < finished
```

### INV-004：Run-local sequence

同一 runId 内 sequence 从 1 开始，严格递增、不重复。不同 Run 可以各自从 1 开始。

### INV-005：Outcome 合法性

```text
success                → 必须有 started
error/execution        → 必须有 started
error/lookup           → 不得有 started
error/validation       → 不得有 started
cancelled              → started 可有可无
skipped                → 不得有 started
```

### INV-006：业务隔离

启用 Trace 与使用 no-op Trace 时，Agent 的：

- RunResult；
- context message 顺序；
- tool 调用次数和顺序；
- thrown error 类别；
- abort 行为

必须一致。

### INV-007：不可变事件

Sink 和订阅者拿到的 TraceEvent 必须是深度只读快照；源 arguments/result 后续变化不能改变已发事件。

### INV-008：Cursor 全局顺序

同一个 Hub 内 cursor 对所有 Session 和 Run 严格递增。过滤器不改变 cursor 的分配。

### INV-009：订阅隔离

任一订阅 slow、close、overflow 或 throw，不影响 Agent、Hub、Sink 或其他订阅。

### INV-010：显式不完整

任何丢失都必须表现为 `TraceGap`、overflow error 或 cursor expired，不能静默产生看似连续的 Trace。

## 6. TraceRecorder 单元测试

### TR-REC-001：确定性 ID 与 sequence

优先级：P0

步骤：

1. 使用固定 clock 和 ID generator 创建 recorder scope。
2. 发出 run.started、tool.requested、tool.started、tool.finished、run.finished。

断言：

- eventId 依次为 `evt_001...evt_005`；
- sequence 依次为 1..5；
- 所有事件使用同一 sessionId/runId；
- 输入 attributes 被复制和冻结。

### TR-REC-002：不同 Run sequence 独立

优先级：P0

两个 Run 交错 emit，分别得到 `[1,2,...]`，不能使用全局 sequence 替代 run-local sequence。

### TR-REC-003：duration 使用 monotonic clock

优先级：P0

requested 后 monotonic 前进 10ms，wall clock 后退 5 秒，再 started；执行 25ms 后 finished。

断言：

```text
queueDurationMs = 10
executionDurationMs = 25
totalDurationMs = 35
```

任何 duration 不得为负。

### TR-REC-004：Sink emit throw 不传播

优先级：P0

ThrowingSink 每次 emit 抛错。Recorder 所有 emit 调用不抛；`onError` 收到错误；Agent Run 仍正常完成。

### TR-REC-005：onError throw 不传播

优先级：P0

Sink 和 `onError` 同时抛错。不得递归 emit，不得改变 Agent outcome。

### TR-REC-006：事件深冻结

优先级：P0

传入嵌套 arguments、result、attributes；emit 后修改原对象并由 MutatingSink 尝试写入事件。

断言：RecordingSink 中的内容保持原快照且嵌套对象不可修改。

### TR-REC-007：非法或不可序列化值降级

优先级：P1

循环引用、BigInt、Map、Date、Error、getter throw 等输入不得从 Recorder 抛回业务路径；按 Spec 降级 capture 并调用 `onError`。

## 7. Agent Run/Tool 生命周期测试

### TR-LIFE-001：无 Tool 的正常 Run

优先级：P0

模型直接返回最终 assistant message。

预期事件：

```text
seq=1 agent.run.started
seq=2 agent.run.finished outcome=success
```

断言 tool event 数为 0，finished 的 assistantTurnCount 为 1、toolCallCount 为 0。

### TR-LIFE-002：单 Tool 成功

优先级：P0

预期核心顺序：

```text
run.started
tool.requested
tool.started
tool.finished(success)
run.finished(success)
```

断言 result capture、duration、ordinal=0、attempt=1 和全部关联 ID。

### TR-LIFE-003：同一 assistant 的多个 Tool 串行成功

优先级：P0

模型一次返回 Tool A、B、C。

预期：

```text
requested(A)
requested(B)
requested(C)
started(A)
finished(A)
started(B)
finished(B)
started(C)
finished(C)
```

必须先发完全部 requested，才允许第一项 started。

### TR-LIFE-004：Tool lookup 失败

优先级：P0

模型请求未注册 Tool。

断言：

- requested 后直接 finished；
- `outcome=error`；
- `failureStage=lookup`；
- 无 started 和 executionDurationMs；
- Agent context 仍得到 error ToolResult。

### TR-LIFE-005：arguments validation 失败

优先级：P0

断言与 lookup 类似，但 `failureStage=validation`，Tool execute 从未调用。

### TR-LIFE-006：Tool 返回 isError

优先级：P0

断言有 started，finished 为 `error/execution`，result 或 error capture 遵循 policy，Agent 继续后续模型调用。

### TR-LIFE-007：Tool 抛普通异常

优先级：P0

断言：

- finished 为 `error/execution`；
- error capture 默认无 stack；
- Agent 写入 error ToolResult；
- 整个 Run 是否 success 继续遵守当前 Agent 语义，Trace 不额外把 Run 强制失败。

### TR-LIFE-008：Tool 执行中 abort

优先级：P0

模型请求 A、B；A execute 使用 Deferred 等待。确认 A started 后调用 `agent.abort()`。

预期：

```text
requested(A)
requested(B)
started(A)
finished(A, cancelled/cancellation)
finished(B, skipped/cancellation)
run.finished(cancelled)
```

B execute 调用次数为 0。

### TR-LIFE-009：第一项 started 前 abort

优先级：P0

使用 ReentrantSink 在全部 requested 产生期间触发 abort。

断言当前项为 cancelled、剩余项为 skipped，所有 Tool 均无 started/execute。

### TR-LIFE-010：Tool 忽略 Abort 后返回

优先级：P0

Tool 捕获/忽略 signal，abort 后仍 resolve 正常值。

断言：

- 正常值不能产生 success finished；
- 当前 Tool finished 为 cancelled；
- 剩余 Tool skipped；
- Agent 不提交迟到正常结果；
- Run finished 为 cancelled。

### TR-LIFE-011：steer 复用 runId

优先级：P0

在 active Run 的 react 阶段加入 steer，触发新的 assistant turn/tool call。

断言所有事件使用同一 runId，不产生第二个 run.started，assistantTurnId 发生变化。

### TR-LIFE-012：follow-up 复用 runId

优先级：P0

在当前 ReAct loop 收敛前加入 follow-up。

断言 follow-up 触发的新 assistant turn 仍使用原 runId，最终只有一对 run.started/finished。

### TR-LIFE-013：下一次 prompt 使用新 runId

优先级：P0

同一 Session 连续完成两个 prompt。

断言 sessionId 相同、runId 不同、每个 Run sequence 独立从 1 开始。

### TR-LIFE-014：调用方预生成 runId

优先级：P0

通过 `AgentRunOptions.runId="run_service_001"` 调用 prompt。

断言：

- RunResult.runId 为该值；
- 全部 TraceEvent.runId 为该值；
- Recorder 不再生成另一个 runId；
- Service Run registry 可以在 prompt Promise settle 前使用该 ID。

### TR-LIFE-015：Provider error + recovery compact

优先级：P1

第一次模型调用失败，recovery compact changed，第二次成功。

断言同一个 Run 只有一个 started/finished；重试不创建新 runId；现有 Tool Trace 不重复。

### TR-LIFE-016：Provider abort/error 分类

优先级：P0

分别测试：

- signal abort；
- provider 返回 stopReason=aborted；
- provider 返回 stopReason=error；
- provider throw AbortError；
- provider throw 普通 Error。

断言 run outcome 精确映射为 cancelled 或 error。

### TR-LIFE-017：Trace 与 context message 顺序隔离

优先级：P0

运行含多 Tool、steer、follow-up 的场景，分别在 trace enabled/disabled 下执行。

断言两次 Agent context messages 深度相等，TraceEvent 从未进入 context。

### TR-LIFE-018：compact 不删除 Trace

优先级：P0

在一个 Run 中让 ContextManager compact 替换消息列表。

断言 compact 前产生的 TraceEvent 仍存在，关联 ID 和 payload 不变。

### TR-LIFE-019：turn limit 不被 Trace 改变

优先级：P1

在 trace enabled/disabled 下运行相同脚本，断言 `turnCount`、达到限制的时点和 `AgentTurnLimitError` 完全一致。

### TR-LIFE-020：手动 compact 的 Trace 边界

优先级：P1

当前 Tool Trace MVP 尚未要求 `context.compact.*` 事件。调用手动 compact 后断言：

- 不伪造 `agent.run.started`；
- 不产生 Tool lifecycle event；
- 已有 Trace 不受 compact 影响。

未来加入 compact event 时，再增加独立 schema 测试，不能复用 Tool event 类型。

## 8. Capture、脱敏和安全序列化测试

### TR-CAP-001：默认 arguments redacted

优先级：P0

输入包含：

```text
authorization
Proxy-Authorization
api_key
api-key
APIKEY
client_secret
accessToken
password
cookie
private-key
```

断言所有键按大小写和 `_/-` 归一规则匹配，值变为 `[REDACTED]`。

### TR-CAP-002：嵌套数组和对象

优先级：P0

敏感键放入至少五层对象、数组元素和混合结构中，全部必须脱敏。

### TR-CAP-003：自由文本不做虚假保证

优先级：P1

字符串正文中包含类似 secret 的文本。默认内置 key redactor 不应声称已识别全部自由文本秘密；为高敏 Tool 配置 `perTool: none/metadata` 后确认正文不保存。

### TR-CAP-004：每 Tool policy override

优先级：P0

同一 Run 调用 publicTool 和 secretTool，分别配置 full 与 none/metadata，断言策略只作用于匹配 Tool。

### TR-CAP-005：binary/image 不记录正文

优先级：P0

输入 ImageContent/base64 和二进制详情，断言只保留 mime、大小和允许的 hash，事件/JSONL/SSE 都不出现 base64 片段。

### TR-CAP-006：截断发生在脱敏之后

优先级：P0

构造含敏感字段且超过 `maxValueBytes` 的值。

断言：

- 输出中无 secret；
- `truncated=true`；
- `originalByteLength` 正确；
- 截断预览来自脱敏后的值。

### TR-CAP-007：循环引用和特殊 JS 值

优先级：P0

覆盖 circular、BigInt、Date、Map、Set、Error、undefined、NaN、Infinity、symbol、function 和 throwing getter。

断言安全序列化行为确定，无法保存时降级 metadata，不影响 Tool 执行。

### TR-CAP-008：递归和节点预算

优先级：P0

构造超深和超宽对象，断言在配置预算内终止并标记截断/降级，不发生 stack overflow 或明显无界 CPU。

### TR-CAP-009：错误默认不含 stack

优先级：P0

默认 capture 只保留 name/code/message。启用 stack policy 时才出现脱敏、截断后的 stack。

### TR-CAP-010：自定义 redact 失败

优先级：P0

自定义 redactor throw 或返回不可序列化值。

断言 Recorder 调用 onError 并降级到安全模式，原始 secret 不得因 fallback 泄漏。

### TR-CAP-011：原对象后续变更

优先级：P0

emit 后修改 Tool arguments/result 原对象，所有 Sink、Hub replay 和订阅 delivery 中的旧事件不变。

## 9. TraceEventHub 和订阅测试

### TR-HUB-001：全局 cursor

优先级：P0

交错 emit Session A/Run 1、Session B/Run 2 的事件。

断言 cursor 在 Hub 中全局严格递增；各 Run 的 sequence 保持自己的顺序。

### TR-HUB-002：start latest

优先级：P0

先 emit A/B，再 subscribe latest，再 emit C/D。

订阅只收到 C/D。

### TR-HUB-003：start earliest_available

优先级：P0

ring capacity=3，依次 emit A/B/C/D，订阅 earliest。

订阅按 cursor 收到 B/C/D。

### TR-HUB-004：start after

优先级：P0

ring 有 A/B/C，使用 A.cursor 订阅，收到 B/C；随后 emit D，继续收到 D。

### TR-HUB-005：replay-to-live 原子切换

优先级：P0

订阅 after A 后、第一次调用 `next()` 前立即 emit D/E。

断言收到 B/C/D/E，各一次且顺序正确。测试不得使用 sleep。

### TR-HUB-006：after latest

优先级：P1

使用当前 tail cursor 订阅，不 replay 旧事件，只接收后续新事件。

### TR-HUB-007：expired cursor

优先级：P0

ring 淘汰 cursor A 后使用 A 订阅。

断言同步得到 `TraceCursorExpiredError`，包含 earliest/latest cursor，且未注册泄漏订阅。

### TR-HUB-008：cross-hub cursor

优先级：P0

把 Hub A cursor 传给 Hub B，必须拒绝，不能按 B 的相同 offset 误续订。

### TR-HUB-009：invalid cursor

优先级：P0

空值、损坏编码、超大 offset 和伪造 instance ID 返回 `InvalidTraceCursorError` 或 cursor-domain error。

### TR-HUB-010：组合过滤

优先级：P0

构造覆盖多个 Session、Run、eventType、toolName、outcome 的矩阵。

断言维度间 AND、维度内 OR；空数组匹配 0；未提供维度不限制。

### TR-HUB-011：过滤不改变 cursor 和 Sink

优先级：P0

订阅只匹配 Tool A，但 Hub 交错收到 Tool A/B。

断言订阅只收到 A；A 的 cursor 中间允许有间隔；JSONL/RecordingSink 收到 A/B 全部事件。

### TR-HUB-012：多个订阅独立

优先级：P0

创建 fast、slow、filtered、closing 四个订阅。关闭或塞满其中一个，不影响其他订阅的顺序和完整性。

### TR-HUB-013：overflow close

优先级：P0

subscriber buffer capacity=2，不消费并 emit 3 个匹配事件。

锁定 MVP 语义：订阅立即异常关闭、释放已缓存 delivery，下一次 `next()` reject `TraceSubscriptionOverflowError`；Hub 和 Agent 继续运行。

### TR-HUB-014：drop_oldest + TraceGap

优先级：P0

buffer capacity=2，emit A/B/C，overflow=drop_oldest。

断言首先收到一个 `TraceGap(droppedCount=1)`，随后收到 B/C；Gap 不进入持久化 Sink。

### TR-HUB-015：连续 overflow 合并 Gap

优先级：P1

不消费并连续 emit 超出容量的多个事件。

断言相邻丢失合并成一个准确 droppedCount；开始正常消费后，新一轮丢失产生新的 Gap。

### TR-HUB-016：pending next + emit

优先级：P0

先调用 `next()` 形成 pending，再 emit 一个匹配事件。pending 正确 resolve，不经过多余 tick。

### TR-HUB-017：pending next + close

优先级：P0

pending `next()` 后调用 close。pending settle 为 `done:true`，不会永远挂起。

### TR-HUB-018：pending next + abnormal close

优先级：P0

overflow 或 Hub error 导致异常关闭时，pending/下一次 `next()` reject typed error。

### TR-HUB-019：iterator.return 清理

优先级：P0

`for await` 提前 break，断言 iterator.return 被执行，Hub subscriber count 下降，buffer 和 signal listener 释放。

### TR-HUB-020：AbortSignal

优先级：P0

覆盖订阅前已 abort、等待中 abort、buffer 非空时 abort。锁定 MVP 语义为正常关闭 `done:true`，不抛业务错误。

### TR-HUB-021：Hub dispose

优先级：P0

Hub dispose：

- 拒绝新订阅；
- settle 所有 pending next；
- 释放 ring 和 subscriber buffer；
- flush/dispose 下游 Sink；
- 多次调用返回同一 Promise。

### TR-HUB-022：下游 Sink 隔离

优先级：P0

配置 Good A、Throwing、Good B 三个 Sink。Throwing emit 不阻止 Good B 和订阅收到相同 eventId。

### TR-HUB-023：flush/dispose 聚合错误

优先级：P1

多个 Sink 在 flush/dispose 失败。Hub 使用 allSettled 继续清理，最终 AggregateError 包含全部错误。

### TR-HUB-024：reentrant emit

优先级：P1

下游 Sink 在收到 A 时同步 emit B。实现必须锁定确定顺序且不损坏 cursor/ring。建议期望 A 完成 fan-out 后 B 获得下一个 cursor；如果实现选择禁止 reentrancy，应同步检测并隔离，而不是无限递归。

### TR-HUB-025：replay 上限

优先级：P1

请求 replay 的事件数超过允许上限时返回 `TraceReplayLimitError`，不建立无界数组或部分订阅。

## 10. Model-based 订阅状态机测试

### TR-MODEL-001：Seeded command sequence

优先级：P1

不强制新增 property-testing 依赖。使用固定 seed 生成 1,000 组命令序列：

```text
emit(event)
subscribe(start/filter/capacity/overflow)
next(subscription)
close(subscription)
abort(subscription)
disposeHub()
```

维护一个纯数组 reference model，与真实 Hub 每步比较：

- ring 内容；
- cursor tail；
- 每订阅 buffer；
- matched/filtered/dropped 计数；
- delivery 顺序；
- open/closed 状态。

失败时输出 seed 和最短可重放 command list。

### TR-MODEL-002：Lifecycle invariant sweep

优先级：P1

随机生成合法 Tool lifecycle（含取消点）并验证 INV-001 至 INV-005。此测试用于发现手写场景未覆盖的组合，不替代具体 P0 用例。

## 11. JSONL Sink 测试

### TR-JSONL-001：一行一个事件

优先级：P0

写入多个事件，文件必须 UTF-8、每行以 `\n` 结束、每行可独立 `JSON.parse`。

### TR-JSONL-002：写入顺序

优先级：P0

快速连续 emit 1,000 个事件，读取顺序与 emit 顺序一致，行内容不交叉。

### TR-JSONL-003：flush

优先级：P0

让底层 writer 延迟，调用 flush 前文件未完整；flush resolve 后所有已接收事件都可见。

### TR-JSONL-004：dispose 幂等

优先级：P0

dispose 等待已有队列、关闭 writer；重复 dispose 返回同一 Promise；dispose 后 emit 行为固定为忽略+onError 或 typed rejection，但不能影响 Agent。

### TR-JSONL-005：writer error

优先级：P0

模拟 open/write/fsync/close 错误，统计 `writeErrors`，触发 onError，队列不无限增长，Agent Run outcome 不变。

### TR-JSONL-006：buffer overflow

优先级：P0

填满异步写队列，验证配置的 `drop_newest`、`droppedEvents` 和 burst error reporting。

### TR-JSONL-007：eventId 去重前提

优先级：P1

JSONL 允许 exporter 重试写出重复 eventId；读取侧 fixture 能按 eventId 去重，不能使用 cursor 或整行文本作为事件身份。

### TR-JSONL-008：轮转边界

优先级：P1

在 size/date rotation seam 注入并发 emit，断言每个事件完整存在于且只存在于一个目标文件，文件内顺序稳定。

### TR-JSONL-009：敏感数据回归扫描

优先级：P0

使用固定 secret canary 运行 capture 场景后，对全部 JSONL 字节执行搜索，任何 canary 命中都使测试失败。

文件测试必须使用测试框架临时目录，不写入仓库或用户目录；清理由 afterEach/finally 完成。

## 12. Session 和 Runtime 生命周期测试

### TR-SESSION-001：session-owned Sink

优先级：P0

`sinkOwnership=session` 时 Session dispose 恰好调用一次 sink flush/dispose。

### TR-SESSION-002：external shared Hub

优先级：P0

两个 Session 共享 Hub 且 ownership=external。关闭 Session A 不得 flush/dispose Hub；Session B 继续产生并订阅 Trace。

### TR-SESSION-003：Service Runtime shutdown 顺序

优先级：P0

断言：

```text
stop new admission
→ abort/finish Sessions
→ dispose SessionRuntime
→ flush TraceEventHub sinks
→ close subscriptions
→ dispose Hub
```

不得先关 Hub 导致 Session 关闭阶段的 finished 事件无处记录。

### TR-SESSION-004：Session dispose closes active Run Trace

优先级：P0

运行中 dispose Session，当前 Tool cancelled、剩余 skipped、run finished cancelled，然后才释放 owned Sink。

### TR-SESSION-005：一个 Session Trace 失败不影响另一个

优先级：P0

Session A capture/sink 失败，Session B 的运行和 Trace 均完整。

## 13. SSE Adapter 测试

SSE 测试必须使用真实 HTTP handler/in-memory server，不通过字符串拼接单元测试替代协议行为。

### TR-SSE-001：基本 Trace frame

优先级：P0

断言：

```text
Content-Type: text/event-stream
Cache-Control: no-cache
id: <TraceRecord.cursor>
event: trace
data: <one-line JSON TraceEvent>
```

data 中 `eventId` 保持不变。

### TR-SSE-002：Last-Event-ID replay

优先级：P0

客户端读取到 cursor B 后断开；期间 emit C/D；携带 Last-Event-ID=B 重连，收到 C/D 后进入 live E，不重复 B。

### TR-SSE-003：query cursor

优先级：P1

query cursor 与 Last-Event-ID 单独提供都有效；两者同时提供且不同返回 400。

### TR-SSE-004：cursor expired

优先级：P0

在响应头发送前发现过期 cursor，返回 409 和稳定 code `trace_cursor_expired`，包含 earliest/latest cursor。

### TR-SSE-005：heartbeat

优先级：P1

使用 fake timer 推进 heartbeat interval，收到 SSE comment；heartbeat 不是 TraceEvent、不进入 JSONL、不改变 run sequence。

### TR-SSE-006：watermark

优先级：P1

过滤器长时间无匹配事件，但 Hub tail 前进。Adapter 发送 `trace.watermark` 和最新 cursor；不伪造 eventId。

### TR-SSE-007：TraceGap 控制帧

优先级：P0

drop_oldest 订阅产生 Gap 时，SSE event=`trace.gap`，data 含 droppedCount/after/next cursor；不能 event=`trace`。

### TR-SSE-008：客户端断开清理

优先级：P0

断开 socket/request signal 后，订阅立即 close，Hub subscriber count 恢复，无 pending next 或 buffer 泄漏。

### TR-SSE-009：慢客户端

优先级：P0

模拟 response backpressure。一个慢 SSE 客户端 overflow/close 不影响 Agent、JSONL 和另一个快 SSE 客户端。

### TR-SSE-010：授权锁定 Session filter

优先级：P0

用户只拥有 Session A，但 query 注入 `sessionIds=B` 或使用 B 的 cursor。服务端必须拒绝或强制锁定 A，绝不能发出 B 的事件。

### TR-SSE-011：跨用户 eventId/cursor 探测

优先级：P0

攻击者提供其他用户的合法 cursor/eventId，不应由错误差异泄漏 Session 是否存在；遵守服务的 403/404 concealment policy。

### TR-SSE-012：payload 脱敏端到端

优先级：P0

固定 secret canary 经过 Agent → Recorder → Hub → SSE，扫描完整 HTTP 字节流，secret 不得出现。

### TR-SSE-013：未知事件类型前向兼容

优先级：P1

客户端 fixture 收到未知 TraceEvent.type 时跳过或通用展示，不关闭流；SSE Adapter 原样转发合法 schema 事件。

## 14. Service Runtime 集成测试

### TR-SVC-001：预生成 runId 全链路一致

优先级：P0

调用 `sendMessage(auto)` 启动 prompt。

断言同一个 runId 出现在：

- HTTP 202 响应；
- Service Run registry；
- `AgentRunOptions.runId`；
- 所有 TraceEvent；
- RunResult；
- Service run terminal event。

### TR-SVC-002：steer/follow-up correlation

优先级：P0

steer/follow-up Operation 各自有 operationId/correlationId，但复用 active runId。不得产生新的 run.started。

### TR-SVC-003：admission 失败无 Trace 假象

优先级：P0

idle+steer、running+prompt、closing+follow-up 返回 409；不得产生假的 run/tool Trace，也不得写入 Product Transcript。

### TR-SVC-004：abort 旧 runId

优先级：P0

Run A 完成后启动 Run B，再 abort A。B 不受影响，Trace 中不出现 B cancelled。

### TR-SVC-005：Trace 与 ServiceEvent 分流

优先级：P1

`/events` 返回 Session/Operation/Message 生命周期；`/trace` 返回 Agent/Tool 事实。两者可通过 sessionId/runId/correlationId 关联，但 schema 不混用。

### TR-SVC-006：manual compact 不伪造 Run

优先级：P1

手动 compact 产生 Service compact Operation/Event；Tool Trace MVP 中不产生 run.started 或 tool lifecycle。已有 Trace 可继续 replay。

## 15. 回归与差分测试

### TR-REG-001：现有 Agent Core 全量回归

优先级：P0

未配置 Trace 时，现有 Agent、Session、SessionRuntime 和 ToolManager 测试无需更改业务断言即可通过。

### TR-REG-002：Trace enabled/disabled 差分

优先级：P0

为同一 deterministic scenario 分别运行：

```text
trace=false
trace=InMemorySink
trace=ThrowingSink
trace=TraceEventHub + slow subscriber
```

比较 RunResult、context snapshot、Tool 调用和 error，全部业务结果相同。

### TR-REG-003：多个 Session 并发

优先级：P0

至少 10 个 Session 并发运行不同脚本，共享 external Hub。

断言：

- 每个 Session/Run 的 Trace 不串线；
- cursor 全局有序；
- run-local sequence 独立；
- 关闭一个 Session 不影响其他 Session 和 Hub。

## 16. 性能和资源测试

这些测试默认作为 benchmark/soak suite，不设置脆弱的普通 CI 毫秒阈值。

### TR-PERF-001：Recorder overhead baseline

比较 no-op Trace、InMemory sink 和 Hub 的 100,000 次 lifecycle emit：

- throughput；
- p50/p95/p99 emit latency；
- heap allocation；
- capture 各模式成本。

输出报告但第一阶段不作为普通 CI hard gate。稳定基线建立后再设置平台分层阈值。

### TR-PERF-002：订阅 fan-out

1、10、100 个订阅者下 emit 固定事件量，验证 Hub emit 不等待消费逻辑，内存受 buffer/ring 上限约束。

### TR-PERF-003：慢消费者 soak

持续产生事件并让部分消费者不读取，运行足够长时间，确认 closed subscription 和淘汰 ring 不残留对象或 listener。

### TR-PERF-004：大 payload capture

在 maxValueBytes、最大深度和最大节点边界附近测试 CPU/heap，确认安全预算有效。

## 17. 测试数据矩阵

### 17.1 Tool outcome

| 场景 | started | outcome | failureStage |
| --- | --- | --- | --- |
| execute success | 是 | success | 无 |
| execute returns isError | 是 | error | execution |
| execute throws Error | 是 | error | execution |
| lookup missing | 否 | error | lookup |
| validation fails | 否 | error | validation |
| abort before execute | 否 | cancelled | cancellation |
| abort during execute | 是 | cancelled | cancellation |
| previous Tool aborts | 否 | skipped | cancellation |

### 17.2 Subscription start

| start | ring 状态 | 预期 |
| --- | --- | --- |
| latest | 任意 | 只接收未来事件 |
| earliest_available | 非空 | 从 ring 首项 replay |
| earliest_available | 空 | 等待未来事件 |
| after(valid) | cursor 仍在 ring/tail | replay 后续再接 live |
| after(tail) | tail 存在 | 不 replay，接 live |
| after(expired) | 已淘汰 | cursor expired |
| after(other hub) | domain 不同 | cursor domain error |
| after(invalid) | 格式非法 | invalid cursor |

### 17.3 Subscriber close

| 触发 | pending next | buffered events | 预期 |
| --- | --- | --- | --- |
| explicit close | 有/无 | 有/无 | 正常 done，释放资源 |
| iterator.return | 有/无 | 有/无 | 正常 done，释放资源 |
| signal abort | 有/无 | 有/无 | 正常 done，释放资源 |
| overflow close | 有/无 | 满 | typed error，释放资源 |
| Hub dispose | 有/无 | 有/无 | hub_disposed close |

### 17.4 Capture mode

| mode | value | metadata | truncation |
| --- | --- | --- | --- |
| none | 不保存 | 最小 | 不适用 |
| metadata | 不保存正文 | 类型/大小/允许的 hash | 不适用 |
| redacted | 保存脱敏值 | 是 | 受 max bytes 限制 |
| full | 保存值 | 是 | 仍受 max bytes 限制 |

## 18. 执行顺序和 Gate

### 18.1 每次提交的快速 Gate

```text
TypeScript check
→ recorder unit tests
→ Agent lifecycle tests
→ Hub/subscription tests
→ existing agent-core regression
```

### 18.2 PR Gate

增加：

- capture/security；
- JSONL filesystem；
- Session lifecycle；
- Service/SSE integration；
- seeded model tests。

### 18.3 Nightly/手动 Gate

- performance benchmark；
- slow subscriber soak；
- 高 Session/Subscriber fan-out；
- 大 payload 和长时间 JSONL rotation。

## 19. 实施建议

建议按测试驱动顺序推进：

1. 先实现 fixture、deterministic clock/ID 和全局 invariant helpers。
2. 写 `TraceRecorder` P0 测试，再实现 Recorder。
3. 写 Tool lifecycle P0 测试，再在 Agent 精确位置埋点。
4. 写 capture 安全测试，再实现 serializer/redactor。
5. 写 Hub latest/after/filter/close P0 测试，再实现订阅。
6. 写 overflow/replay/model tests，再完善边界。
7. 写 JSONL 测试，再实现异步 Sink。
8. 最后实现 Service SSE Adapter 和授权测试。

不要先实现 Console 输出。Console 是 TraceEvent 的 View，优先级低于事件闭合、脱敏、持久化和订阅正确性。

## 20. 开工前需要锁定的语义

本计划按照以下选择设计测试，实施前如要改变，应先修改 Spec 和测试计划：

1. 默认 subscriber overflow 为 `close`，不是静默 drop。
2. overflow close 立即丢弃该订阅的 buffer，并让 next reject typed error。
3. `drop_oldest` 必须在后续事件前产生 TraceGap。
4. pre-aborted subscription 返回正常关闭的 subscription。
5. cursor 包含 Hub instance domain，不能跨 Hub 使用。
6. replay 数量有独立硬上限，超过时整体拒绝订阅。
7. Agent Service 预生成 runId 并传入 Agent Core。
8. 手动 compact 暂不产生 Tool Trace 或伪造 Agent Run。
9. shared Hub 使用 `sinkOwnership=external`。
10. SSE cursor expired 在 headers 未发送时返回 HTTP 409。

其中第 2、4、6 和 reentrant emit 的精确行为在 Trace Spec 中仍带有实现选择空间。代码开始前应把最终选择回写到 Spec，避免不同实现者写出相互冲突的测试。

## 21. 完成定义

测试设计完成的判定条件：

- 所有 Trace Spec P0 行为都有至少一个正向和一个失败/取消测试；
- requested/started/finished 的所有合法组合均有覆盖；
- replay-to-live、cursor expired 和两种 overflow policy 均有确定断言；
- Trace failure 与 Agent 业务隔离有差分测试；
- capture policy 的安全默认值有端到端 canary 扫描；
- shared Hub、Session ownership 和 shutdown 顺序有生命周期测试；
- SSE 的续订、鉴权、慢消费者和断开清理有集成测试；
- 单元测试全部使用 deterministic fixture，不依赖 sleep 或公网；
- 性能测试与功能 CI 分离，避免产生平台相关 flaky gate。
