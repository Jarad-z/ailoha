# Core Run、Turn 与 Step 在 Kimi Code 和 Pi 中的语义差异

**Summary**: Kimi Code 的 `Step` 大致对应 Pi Coding Agent 的 `Turn`，Kimi Code 的 `Turn` 大致对应 Pi 的 Core Run。两边差异源于观察视角不同：Pi 以模型对话和事件流为中心，Kimi 以用户任务、调度、恢复与可观测性为中心。

**Type**: 世界知识

**Sources**: 本地 `pi` 0.84.1（commit `75c7fd662`）；本地 `kimi-code`（commit `a41a09c33`）的 agent-core v1、agent-core-v2 源码。

**Last updated**: 2026-09-12

---

## 先给结论

不要直接用名字把两边的 `Turn` 对齐。按实际生命周期和所包含的工作量，近似关系是：

```text
Kimi Code Step  ≈ Pi Coding Agent Turn
Kimi Code Turn  ≈ Pi Core Run
```

更完整的映射如下：

| 运行粒度 | Pi Coding Agent | Kimi Code |
|---|---|---|
| 一次完整产品响应链 | `AgentSession` operation | Prompt / Goal 等上层操作 |
| 一趟底层 Agent 循环 | Core Run | Turn |
| 一次 LLM 决策与工具执行 | Turn | Step |
| 一个工具动作 | Tool Call | Tool Call |
| 一次 HTTP/SDK 请求重试 | Provider Attempt | Provider Attempt |

这是一种生命周期近似，而不是类、函数或事件的一一对应。尤其是 Pi 的 Core Run 可以吸收 Steering 和 Follow-up，Kimi v2 则会通过带 admission 语义的 `StepRequest` 判断输入属于当前 Turn、下一个 Turn，还是必须新建 Turn。

## 用一个具体任务理解

假设用户输入：“帮我定位并修复这个测试失败。”

```text
一次产品级请求
│
├─ Pi Coding Agent
│  └─ Core Run
│     ├─ Turn 1：LLM → 搜索代码 → Tool Result
│     ├─ Turn 2：LLM → 修改文件 → Tool Result
│     ├─ Turn 3：LLM → 运行测试 → Tool Result
│     └─ Turn 4：LLM → 最终回答
│
└─ Kimi Code
   └─ Turn
      ├─ Step 1：LLM → 搜索代码 → Tool Result
      ├─ Step 2：LLM → 修改文件 → Tool Result
      ├─ Step 3：LLM → 运行测试 → Tool Result
      └─ Step 4：LLM → 最终回答
```

因此，Kimi 的一个 Step 与 Pi 的一个 Turn 都覆盖“一次模型响应，以及这条响应触发的零个或多个工具调用”。

## Core：架构层，不是时间单位

`Core` 首先表示架构层级，而不是一种循环次数。

Pi 的 `packages/agent` 提供通用 Agent Core；`packages/coding-agent` 在它上面增加 `AgentSession`、扩展、Session 持久化、自动重试和上下文压缩等产品能力。所谓 **Pi Core Run**，是为了区分底层 `Agent` 的一趟运行与上层 `AgentSession` 的完整产品操作。

Pi 源码没有正式导出名为 `CoreRun` 的类型。这个概念是从以下真实边界归纳出来的：

- `Agent.activeRun` 保存本趟运行的 Promise 和 `AbortController`；
- `runWithLifecycle()` 创建、收口并清理 `activeRun`；
- `runAgentLoop()` 发出 `agent_start`，`runLoop()` 最终发出 `agent_end`；
- 所有 awaited event listener 结束后，`finishRun()` 才真正把 Agent 置为 idle。

(source: `pi/packages/agent/src/agent.ts:313-329, 409-435, 486-542`; `pi/packages/agent/src/agent-loop.ts:95-149`)

Kimi 的 `agent-core` 也表示核心架构层。Kimi v1 明确把 `loop` 描述为无状态 Agent Loop，并把 Session、Wire Transport、Compaction、权限 UI 和持久协议桥接交给 Host 层。(source: `kimi-code/packages/agent-core/src/loop/README.md:1-5`)

这体现了 [[状态所有权与无状态Loop|状态所有权与无状态 Loop]]：判断一个概念是不是生命周期单元，要看谁拥有状态、取消、预算和结束结算，而不是只看函数名。

## Run：必须说明是谁的一趟运行

`Run` 本身只是“执行一遍”，不是跨框架通用的固定术语。

### Pi 的 Core Run

Pi 一趟 Core Run 的主路径是：

```text
Agent.prompt() 或 Agent.continue()
→ runWithLifecycle()
→ runAgentLoop() / runAgentLoopContinue()
→ runLoop()
→ agent_end
→ awaited listeners 结算
→ finishRun()
→ activeRun = undefined
```

它拥有一个共同的取消信号、一份本 Run 的 Context 快照、一组 `newMessages` 增量和一段 `agent_start → agent_end` 事件流。(source: `pi/packages/agent/src/agent.ts:347-435, 486-542`; `pi/packages/agent/src/agent-loop.ts:95-149`)

### Kimi 的 `run()`

Kimi v2 的 `AgentLoopService.run()` 接收 `turnId`，不断从当前 Turn 的 `StepRequestQueue` 取出请求并执行 Step，直到队列为空、被取消、达到最大 Step 数、Hook 要求停止或错误无法恢复。(source: `kimi-code/packages/agent-core-v2/src/agent/loop/loopService.ts:496-550, 572-667`)

因此，Kimi 的 `run()` 是“执行一个 Turn”的实现方法，不是另一个稳定的、比 Turn 更高一级的产品生命周期对象。不能因为两边都有 `run` 字样，就把 Kimi `run()` 和 Pi Core Run 按函数名机械对齐。

## Pi 的 Turn：一次 Assistant 响应与工具结果批次

Pi 的一个 Turn 可以概括为：

```text
turn_start
→ 调用 LLM
→ 得到一条 AssistantMessage
→ 执行其中零个或多个 Tool Call
→ 把 ToolResult 写回 Context
→ turn_end
```

`runLoop()` 每次内层循环都会请求一条 AssistantMessage，执行其中的整个工具批次，然后发出一次 `turn_end`。只要产生了工具调用，工具结果写回后就进入下一次循环，也就是新的 Pi Turn。(source: `pi/packages/agent/src/agent-loop.ts:169-260`)

Pi 因而采取“模型对话轮次”视角：模型说一次话并完成这次话语触发的动作，就是一个 Turn。工具结果回来后，模型再次说话，就是下一个 Turn。

Pi Core 没有把 Step 建模成与 Kimi 相同的一等对象。开发者可以口头把一次 Pi Turn 称为 model step，但 Pi Core 中没有一个同时拥有 Step ID、Step 状态、Step 取消句柄和 Step Result Promise 的正式 `Step` 对象。

## Kimi 的 Step：一次可追踪的模型行动原子单元

Kimi 的 Step 覆盖：

```text
turn.step.started / step.begin
→ before-step hooks
→ 物化本 Step 的 Context Message
→ 构造并发送 LLM 请求
→ 记录 Assistant Content
→ 执行 Tool Calls
→ 记录 Tool Results
→ step.end / turn.step.completed
→ after-step hooks
```

(source: `kimi-code/packages/agent-core-v2/src/agent/loop/loopService.ts:536-570, 687-850`)

一个 Step 如果执行了工具，模型需要再读取工具结果。Kimi v2 的 `loopContinuation` 在 `onDidFinishStep` 中观察到 `finishReason === "tool_calls"` 后，排入一个 `ContinuationStepRequest`，从而驱动下一个 Step。(source: `kimi-code/packages/agent-core-v2/src/agent/loop/loopContinuationService.ts:1-39`)

```text
Step 1：模型决定调用工具
Step 2：模型读取工具结果，再决定下一步
```

这两步在 Pi 中会被称为两个 Turn。

## Kimi 的 Turn：包含多个 Step 的可调度任务

Kimi v2 的 Turn 是一个有稳定身份和生命周期的工作任务。它拥有：

- `turnId`；
- `queued/running/completed/failed/cancelled` 状态；
- 独立 `AbortSignal`；
- `ready` 与 `result` Promise；
- `cancel()`；
- 自己的 `StepRequestQueue`；
- `turn.started/turn.ended` 事件；
- `maxStepsPerTurn` 预算。

(source: `kimi-code/packages/agent-core-v2/src/agent/loop/loop.ts:66-132`; `kimi-code/packages/agent-core-v2/src/agent/loop/loopService.ts:249-275, 346-431`)

Turn 通常在以下情况下结束：

```text
StepRequest 队列为空
或 Hook 设置 stopTurn
或用户取消
或错误无法恢复
或达到 maxStepsPerTurn
```

Kimi v1 的实现结构更小，但语义已经相同：`runTurn()` 在一个 `while` 中反复执行 `executeLoopStep()`；Step 返回 `tool_use` 就继续，否则 Turn 收敛退出。(source: `kimi-code/packages/agent-core/src/loop/run-turn.ts:89-235`)

## 为什么 Pi 这样设计

### 1. Pi 以模型协议和事件流为中心

一次 AssistantMessage 加上它触发的工具结果，是很自然的事件边界：

- UI 可以围绕一条 AssistantMessage 做流式展示；
- 工具批次完成后再发送 `turn_end`；
- 每个 Turn 后都有安全点检查 Steering；
- 工具结果写回后再次调用模型，自然形成下一个 Turn。

这种命名贴近 Chat Completion 的对话轮次，而不是产品任务调度。

### 2. Core Run 集中管理一组 Turn 的资源生命周期

同一 Core Run 内的多个 Turn 共用：

- 一个 `AbortController`；
- 一个 `activeRun` 并发闸门；
- 一份运行 Context；
- 一组新消息增量；
- 一段 `agent_start/agent_end` 事件流。

这样不需要给每次 LLM 调用都重新建立完整 Agent 生命周期。

### 3. 产品策略留在 AgentSession

Pi 把自动重试、Context Overflow 后压缩、扩展回调、迟到消息和最终 settled 放在 Coding Agent 的 `AgentSession` 中。一条产品级响应链因此可以串行启动多趟新的 Core Run：

```text
AgentSession operation
├─ Core Run #1
├─ post-run：发现需要自动压缩
├─ Core Run #2：agent.continue()
├─ post-run：发现迟到消息
└─ Core Run #3：agent.continue()
```

(source: `pi/packages/coding-agent/src/core/agent-session.ts:1063-1104`)

这说明 `agent_end` 只代表当前 Core Run 不再产生 Loop 事件；`agent_settled` 才表示上层产品响应链完成。这个边界也可参见 [[产品级Operation与AgentLoop的分层关系|产品级 Operation 与 AgentLoop 的分层关系]]。

### Pi 设计的收益与代价

收益：

- Core 小而通用，便于被不同 Host 嵌入；
- Loop 不绑定产品级 Session、压缩和持久化策略；
- 调用和事件模型直接，作为 SDK 容易理解和复用。

代价：

- `agent_end` 不等于产品响应彻底结束；
- Turn 没有 Kimi Step 那样的一等 Handle；
- Step 预算、细粒度取消和追踪更多依赖 Host 补充；
- Product Operation、Core Run 和 Turn 容易被读者混为一谈。

## 为什么 Kimi 这样设计

### 1. Kimi 以用户任务和调度生命周期为中心

Turn 有稳定 ID、状态、取消、结果和起止事件，适合直接支撑：

- TUI/Web 状态展示；
- RPC 与 Prompt 排队；
- Wire Journal、恢复与回放；
- Telemetry；
- Goal 连续执行；
- 多入口向运行中的 Agent 注入工作。

即使一个 Turn 还在队列中，调用者也可以先获得稳定 Handle，并等待 `ready` 或 `result`。

### 2. Step 是可靠性控制的合适原子单位

一次 LLM 请求与工具批次天然适合记录：

- Step 序号与 UUID；
- Token Usage；
- 首 Token 延迟和流式耗时；
- Provider Retry；
- Context Overflow 恢复；
- Step 级取消；
- `maxStepsPerTurn` 防死循环；
- `step.begin/step.end` 持久化边界。

因此 Kimi 将 Step 正式建模，而不是只把它当作循环的一次迭代。

### 3. StepRequest 统一多种输入来源

推动 Kimi Agent 的不只有用户 Prompt，还包括 Steering、工具后续执行、Goal、External Hook、后台 Task 通知、错误重试和 Compaction 恢复。Kimi v2 把它们统一成 `StepRequest`，再用 admission policy 表达归属：

| Admission | 含义 |
|---|---|
| `newTurn` | 必须新建 Turn |
| `activeOrNewTurn` | 有活动 Turn 就加入，否则新建 |
| `activeOrNextTurn` | 有活动 Turn 就加入，否则等待下一个 Turn |
| `activeTurnOnly` | 只能进入当前活动 Turn |

(source: `kimi-code/packages/agent-core-v2/src/agent/loop/stepRequest.ts:21-84`; `kimi-code/packages/agent-core-v2/src/agent/loop/loopService.ts:138-181`)

StepRequest 到真正出队时才调用 `resolveContextMessages()`，把消息写进 Context。因此，一个还在排队、后来被取消的请求不会先污染模型历史。这是 [[从隐式while到显式StepRequest调度|从隐式 `while` 到显式 `StepRequest` 调度]] 的核心收益。

### 4. Loop 只保留机制，Continuation 属于策略

Kimi v2 的 Loop 自己只消费队列，不负责决定什么情况下生成下一项工作。不同 Aspect 分别承担：

```text
Loop：怎样执行队列
LoopContinuation：工具执行后何时继续
StepRetry：什么错误重跑
FullCompaction：什么错误先压缩再重跑
Goal：何时跨 Turn 继续
```

这样可以分别测试和替换机制，但也带来了更多 Service、Hook、事件和请求类型。

### Kimi 设计的收益与代价

收益：

- Turn 和 Step 都有清晰身份与可观察生命周期；
- 多生产者并发输入可以统一排队、合并、取消和归属；
- 重试、压缩、预算、Telemetry 与持久化都有明确挂点；
- 更适合完整产品运行时和长时间自治任务。

代价：

- 类型、Service 和队列协议更多；
- 理解成本高于 Pi 的结构化 `while`；
- 对只有“用户 Prompt → 工具循环 → 回答”的简单 Host，可能承担不必要的架构税。

## 两种 Turn 命名背后的观察视角

```text
Pi：从模型往外看
    模型每产生一次 AssistantMessage，就是一个 Turn

Kimi：从用户任务往里看
      用户发起的一趟 Agent 工作，是一个 Turn
      其中每次模型“思考—行动—观察”，是一个 Step
```

所以两套命名都说得通，只是观察者不同：

- Pi 的观察者更像 LLM 对话协议和嵌入式 SDK；
- Kimi 的观察者更像产品调度器、任务系统和可观测平台。

## 阅读其他 Harness 时怎么判断

不要先相信 `Run/Turn/Step` 的名字。依次检查：

1. 谁拥有自己的 ID？
2. 谁拥有 `AbortController` 或 `AbortSignal`？
3. 谁拥有预算计数？
4. 谁有明确的 start/end 事件？
5. 谁能独立返回或等待 Result？
6. 一次 LLM 请求属于哪个对象？
7. 工具结果回来后，是新 Step、新 Turn，还是仍在原对象内？
8. Retry 重放的是 HTTP Attempt、Step、Turn，还是整个产品 Operation？

按这些标准，最终可得到：

```text
Pi
├─ AgentSession operation：产品响应链
├─ Core Run：底层资源与事件生命周期
└─ Turn：一次模型响应与工具批次

Kimi
├─ Prompt / Goal：产品级编排
├─ Turn：可排队、取消、等待的任务生命周期
└─ Step：一次模型响应与工具批次
```

## Related pages

- [[Pi-AgentLoop与Kimi-Code-v2-LoopService对比|Pi Agent Loop 与 Kimi Code V2 LoopService 对比]]
- [[产品级Operation与AgentLoop的分层关系|产品级 Operation 与 AgentLoop 的分层关系]]
- [[从隐式while到显式StepRequest调度|从隐式 while 到显式 StepRequest 调度]]
- [[状态所有权与无状态Loop|状态所有权与无状态 Loop]]
- [[执行循环的哑管道原则]]

