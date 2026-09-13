# 长 Session 的 Context 压缩设计

## 问题

一个 Session 已经连续对话 200 轮，Context 即将达到上限。应该如何进行压缩？如何确保压缩后的对话仍然流畅？

## 一、首先澄清：不应该按照对话轮数触发压缩

“200 轮”只能用于描述这是一个长 Session，不能作为真正的压缩条件。对话轮数和 Token 消耗没有固定关系：普通聊天每轮可能很短，200 轮未必达到上限；但在 Coding Agent 中，一次文件读取、测试日志、Git Diff 或 Tool Result 就可能产生几千甚至几万 Token，十几轮甚至几轮就可能需要 Compact。

因此，Runtime 应该根据以下信息动态判断是否压缩：

- 当前 Context 已使用的 Token；
- 模型的 Context Window 上限；
- System Prompt 与 Tool Schema 的固定开销；
- 为本轮输出预留的 Token；
- 预计下一次 Tool Result 的大小；
- 当前业务所需的 Safety Buffer。

压缩条件应该基于 Token Budget，而不是固定轮数。

---

## 二、需要分开处理 History Context 与当前 Turn

压缩时存在两个不同的信息区域：

```text
Session Context
├── History Context：当前 Turn 之前的历史
└── Active Turn：用户最新消息以及本轮已经发生的执行过程
```

二者的压缩目标不同，不能混在一起讨论。

对于 **History Context**，主要需要保证：

1. 语义连续性；
2. 任务一致性。

对于 **Active Turn**，主要需要保证：

3. 当前意图保真。

当前意图不是语义连续性或任务一致性的一部分。前两者描述的是历史 Context 被压缩后还能否继续提供正确背景；当前意图描述的是用户这一轮最新要求究竟是什么。当前 Turn 可能延续、修改、否定甚至完全替换历史任务，因此应该单独保存，并具有更高的保留优先级。

---

## 三、History Context：语义连续性与任务一致性

### 3.1 语义连续性

语义连续性解决的是：压缩之后，Agent 是否仍然能理解当前对话与历史之间的关系。

需要保留的信息包括：

- 人物和对象分别是谁；
- “他”“那个方案”“刚才的问题”等指代指向什么；
- 当前正在讨论哪个话题；
- 重要事件之间的时间和因果关系；
- 用户当前的态度、偏好和情绪变化；
- 哪些话题尚未结束。

如果这些信息丢失，Agent 即使语言表达自然，也会表现得像突然失忆，无法正确接上用户的话。

### 3.2 任务一致性

任务一致性解决的是：压缩之后，Agent 是否仍然围绕原来的目标和约束执行任务。

需要保留的信息包括：

- `goal`：最终要完成什么；
- `constraints`：不能做什么、必须满足什么；
- `decisions`：已经确认了哪些决策；
- `current_state`：任务目前处于什么状态；
- `completed_actions`：已经完成了什么；
- `open_issues`：还有哪些问题；
- `next_actions`：下一步应该做什么；
- `success_criteria`：什么情况下可以认为任务完成。

如果这些信息丢失，Agent 可能仍然能接上对话，但会修改不该修改的代码、重复已经完成的工作，或者执行一个已经被废弃的方案。

### 3.3 根据业务场景调整两者权重

语义连续性和任务一致性不是简单的二选一。真正需要权衡的是：在有限的 History Context Budget 中，哪些信息应该被优先保留。

#### 陪伴聊天

陪伴聊天更重视语义连续性，适合保存：

```yaml
entities:
relationships:
important_events:
emotional_state:
user_preferences:
unresolved_topics:
```

例如用户说“他今天又联系我了”，Agent 不仅要知道“他”是谁，还要知道对方以前做过什么、用户对他的态度，以及这件事为什么会引起当前的情绪。

#### Coding Agent 或长程任务

Coding Agent 和长程任务更重视任务一致性，适合保存：

```yaml
goal:
constraints:
decisions:
current_state:
completed_actions:
open_issues:
next_actions:
success_criteria:
```

例如：

```yaml
goal:
  修复并发刷新 Token 的竞态

constraints:
  - 不修改公共 API
  - 不增加第三方依赖

decisions:
  - 使用 singleflight 合并并发请求

current_state:
  modified_files:
    - src/auth/token.ts
  tests:
    passed: 18
    failed: 1

open_issues:
  - logout 与 refresh 并发时仍然存在竞态

next_actions:
  - 修复剩余竞态
  - 运行完整测试
```

#### 高风险操作

金融、生产环境变更、数据删除等场景中，任务一致性和事实精确性具有最高优先级。金额、时间、操作对象、授权范围和用户确认等信息不能只保留模糊摘要，应该保存确定的结构化值，并保留原始消息引用。

因此，不同 Agent 不应该机械地共用完全相同的摘要格式。可以设计一个通用 Context Snapshot，再根据业务场景选择字段、保留比例和压缩策略。

---

## 四、Active Turn：单独保证当前意图保真

当前 Turn 代表用户最新、优先级最高的要求。它不应该被混入 History Context 的摘要中，而应该作为独立工作集保存。

当前意图保真需要回答：

- 用户这一轮要执行什么动作；
- 动作作用于什么对象；
- 用户期望得到什么结果；
- 本轮新增了哪些约束；
- 本轮是在继续、修改、否定还是替换历史任务；
- 如果已经开始执行，本轮目前进行到了哪里。

建议同时保存用户消息原文和结构化意图：

```yaml
active_turn:
  raw_user_message:

  intent:
    action:
    target:
    expected_result:

  constraints:

  relation_to_previous_task:
    type: continue | modify | reject | replace
    references:

  execution_state:
    completed_tool_calls:
    critical_tool_results:
    current_action:
    pending_actions:
```

必须同时保留 `raw_user_message` 和 `intent`：

- 原始消息保存用户的准确措辞，避免压缩器或意图识别器改写用户要求；
- 结构化意图方便 Runtime 和 Agent 快速确定本轮动作；
- 如果二者发生冲突，应重新基于原始消息解析，而不是直接相信摘要。

例如用户说：

> 刚才那个 Redis 方案不要了，改成本地缓存，但公开 API 保持不变，继续做。

应该分别保存：

```yaml
active_turn:
  intent:
    action: 继续实现当前任务
    change: 从 Redis 改成本地缓存

  constraints:
    - 公开 API 保持不变

  relation_to_previous_task:
    type: modify
    rejected:
      - Redis 方案
```

这里三个目标的区别是：

```text
当前意图保真：这一轮到底要做什么？
语义连续性：这一轮提到的人和事分别指什么？
任务一致性：执行结果是否仍符合整体目标与约束？
```

压缩可以损失旧历史中的部分细节，但不能改写当前 Turn 的意图。

---

## 五、压缩后的 Context 采用分层结构

我不会把全部历史总结成一段自然语言，也不会只保留结构化 JSON。更合适的方式是组合以下几层：

```text
1. 当前 Turn 原始消息与结构化意图
2. 最近若干轮原文
3. History 的结构化任务或对象状态
4. History 的自然语言语义摘要
5. 原始历史的可追溯引用
```

各层作用不同：

- 当前 Turn 保证最新意图不发生漂移；
- 最近原文负责承接即时指代、语气和局部上下文；
- 结构化状态保证任务一致性；
- 自然语言摘要保存难以字段化的关系、情绪和因果；
- 原始历史引用负责按需恢复被有损压缩删除的细节。

---

## 六、先对信息分类，再决定压缩、外置或保留

在选择压缩算法之前，系统必须先理解 Context 中的信息类型。不同信息对精度、时效性和可恢复性的要求不同，不能全部使用同一种摘要策略。

这里需要特别区分两个概念：

> **不能有损压缩，不等于必须永久放在 Context 中。**

例如用户购买商品的准确金额、订单号、时间和收货地址不能被概括成“大约花了几百元”，但可以作为结构化事实无损地存入外部数据库。当前对话需要时，再将准确值召回 Context。

### 6.1 信息分类的判断维度

我会从以下几个维度对信息进行分类：

- **精度敏感度**：是否必须保留准确数值和原始措辞；
- **错误成本**：记错后只是影响体验，还是会造成资金、安全或执行错误；
- **当前相关性**：是否与当前 Turn 和下一步动作直接相关；
- **可恢复性**：能否从数据库、文件或工具中重新获取；
- **稳定性**：是长期稳定事实，还是随时间变化的临时状态；
- **关系性**：是否描述人物、对象或多个实体之间的关系；
- **来源权威性**：来自用户确认、工具事实，还是 Agent 的推测；
- **体积**：是否为代码、日志、文档等大体积内容。

系统根据这些属性决定三个问题：

```text
如何表示：原文、精确结构化值，还是语义摘要？
存放哪里：当前 Context，还是外部持久化存储？
何时召回：始终注入、条件注入，还是按需检索？
```

### 6.2 分层处理策略

#### 第一层：当前意图与即时工作集

包括：

- 当前 User Message 原文；
- 当前意图和约束；
- 本轮关键 Tool Call 与 Tool Result；
- 正在执行的动作和待执行动作。

这部分具有最高当前相关性，应直接保留在 Context 中，不能被普通历史摘要覆盖。

#### 第二层：精确事实与高风险约束

包括：

- 金额、订单号、时间、地址；
- 用户授权范围；
- 生产环境操作对象；
- 明确的禁止条件；
- 已确认的关键参数。

这部分不能有损压缩，应该保存为精确结构化值，并携带来源、版本和确认状态。它不一定长期占用 Context，可以外置持久化，在相关任务或高风险操作前准确召回和重新校验。

```yaml
facts:
  - key: purchase_amount
    value: 399.00
    currency: CNY
    status: confirmed
    source_event_id: event_208
    updated_at: 2026-09-12T10:30:00+08:00
```

#### 第三层：实体、关系与长期状态

人物关系、组织关系、项目对象和稳定偏好适合外置为实体存储、关系表或知识图谱：

```yaml
entities:
  user:
    relationship_to_xiaowang: former_colleague
  xiaowang:
    latest_event: contacted_user_again
```

外置之后，不需要把完整关系网络长期放入每一次请求。Runtime 可以根据当前消息识别出的实体，只召回与当前话题相关的局部子图或关系记录。

知识图谱不是所有场景的默认选择：

- 实体稳定、关系复杂时，可以使用图存储；
- 事件时间顺序重要时，可以使用事件流或时间线；
- 主要依靠语义相似性召回时，可以使用向量检索；
- 精确业务事实更适合关系数据库或 Key-Value 存储。

#### 第四层：任务状态与阶段性结论

任务目标、约束、决策、执行状态和未完成事项适合进行结构化压缩，形成可更新的 Checkpoint。它们通常应该注入任务型 Agent 的 Context，但不需要保留产生这些状态的全部过程。

#### 第五层：可概括的历史语义

已经结束的讨论、重复解释、低风险对话和阶段性过程可以压缩成自然语言摘要。其作用是提供背景，而不是作为精确事实来源。

#### 第六层：大体积且可重新获取的信息

包括：

- 完整代码文件；
- 测试日志；
- 搜索结果；
- 文档全文；
- 大型 Tool Result；
- 图片、音频和其他多模态内容。

这些内容优先外置，只在 Context 中保存元数据、关键片段、摘要和 `artifact_id`。需要细节时，通过工具按需读取相关部分。

### 6.3 信息状态会随任务变化

信息分层不是一次性、静态的分类。同一条信息在不同阶段可能具有不同优先级。

例如一个错误日志：

```text
正在定位错误时：属于当前工作集，应保留关键原文
错误原因确认后：压缩为阶段性结论
任务完成后：完整日志外置，只保留引用
```

因此，Runtime 需要支持信息的提升、降级和失效：

- 与当前 Turn 直接相关的信息提升到 Active Context；
- 已完成阶段的过程信息降级为摘要或外部引用；
- 被新指令替换的决策标记为 `superseded`，而不是与新决策混在一起；
- 随时间变化的事实设置更新时间或 TTL；
- Agent 推测与用户确认、工具事实分开记录。

### 6.4 最终形成信息处理策略表

| 信息类型 | 是否允许有损压缩 | 推荐存储 | Context 注入方式 |
|---|---:|---|---|
| 当前 User Message 与意图 | 否 | Event Log + Active Turn | 始终保留原文与结构化意图 |
| 金额、时间、授权等精确事实 | 否 | 结构化数据库 | 相关任务或执行前精确召回 |
| 人物与实体关系 | 通常不直接摘要关键关系 | 图、关系表或事件存储 | 按当前实体召回局部关系 |
| 任务目标、约束和状态 | 可以结构化压缩 | Checkpoint Store | 任务执行期间持续注入 |
| 一般历史对话 | 可以 | 摘要与 Event Log | 保留摘要，必要时查原文 |
| 代码、日志和大型工具结果 | 可以只压缩 Context 副本 | Artifact Store | 保存摘要、关键片段和引用 |

所以，Context 管理的前提不是先决定“用什么摘要模型”，而是先建立一套信息认识：知道什么必须精确、什么可以概括、什么适合外置、什么必须常驻，以及什么情况下需要重新召回。

---

## 七、通过可追溯性弥补有损压缩

Context 压缩本质上是有损的。形成结构化摘要之后，Agent 得到的是历史状态的抽象，而不是完整历史。用户的准确措辞、例外条件、决策依据和完整 Tool Result 都可能被删除。

因此，压缩摘要不应该成为唯一事实来源。

我会将原始的 User Message、Assistant Action、Tool Call、Tool Result 和状态变化持久化为追加式 Event Log，可以使用 JSONL，也可以使用数据库：

```jsonl
{"event_id":"e101","type":"user_message","content":"不要修改数据库结构"}
{"event_id":"e102","type":"tool_call","tool":"read_file","arguments":{"path":"src/auth.ts"}}
{"event_id":"e103","type":"tool_result","content":"..."}
```

压缩后的 Context Snapshot 保存来源信息：

```yaml
checkpoint_id: checkpoint_12

source_event_range:
  start: e001
  end: e103

constraints:
  - value: 不修改数据库结构
    status: confirmed
    source_event_ids:
      - e101
```

生产实现中，不建议只记录 JSONL 行号，因为文件合并、迁移或并发写入都可能让行号发生变化。更稳定的标识包括：

- `session_id`；
- `turn_id`；
- `event_id`；
- `checkpoint_id`；
- `artifact_id`；
- `source_event_range`。

同时向 Agent 提供历史检索工具。当出现以下情况时，Agent 可以按需读取原始记录：

- 当前消息存在无法解析的指代；
- 摘要中只有结论，没有具体依据；
- 不同状态之间发生冲突；
- 用户质疑 Agent 的记忆；
- 需要精确恢复代码、日志、金额或日期；
- 即将进行支付、删除或生产变更等高风险操作。

检索可以组合使用 Event ID 精确读取、时间范围过滤、关键词检索、语义检索和实体过滤。日常情况下使用摘要，只有信息不足时才补回相关原文，而不是把全部历史重新放回 Context。

因此：

> 结构化摘要是快速路径，原始 Event Log 是事实来源，历史检索工具是信息不足时的恢复路径。

---

## 八、工程上的三个压缩检查点

### 8.1 Pre-turn / 第一次 LLM Dispatch 前

用户消息到达后、第一次调用 LLM 之前，Runtime 计算 Token Budget。

如果触发压缩：

```text
旧 History → 压缩
最新 User Message → 原文保留
```

然后重新组装：

```text
System Prompt
+ 压缩后的 History Context
+ 最近若干轮原文
+ Active Turn 原始消息与结构化意图
```

这里不能把最新用户消息混入旧历史摘要，因为它可能正在修改或替换旧目标。

### 8.2 Agent Loop 内每次 LLM Dispatch 前

一个 Turn 中可能发生多次循环：

```text
LLM Dispatch
→ Tool Call
→ Tool Result
→ LLM Dispatch
→ Tool Call
→ Tool Result
→ LLM Dispatch
```

Tool Result 可能非常大，因此不能只在 Turn 开始时检查。每次准备再次 Dispatch LLM 前，都应该重新计算 Token Budget。

如果触发压缩，需要保护整个 Active Turn，而不只是最后一个 Tool Result：

```yaml
active_turn:
  raw_user_message:
  interpreted_intent:
  constraints:
  completed_tool_calls:
  critical_tool_results:
  discoveries:
  current_state:
  pending_actions:
```

完整工具结果可以外置，但应该在 Context 中保留工具名称、调用参数、关键结果和原始结果引用。

如果继续使用原始 Function Calling 消息协议，Assistant Tool Call 和对应 Tool Result 必须保持合法配对；如果重新构建全新的 Context，则可以把已经完成的调用转换成结构化 Active Turn State。

### 8.3 Context Overflow Recovery

Context Overflow 不应该是日常压缩路径，而是前两个检查点未能控制容量时的兜底机制。

发生 Overflow 后：

1. 从持久化 Event Log 读取 Session 状态；
2. 回到最后一个成功持久化的 Checkpoint；
3. 重建当前 Turn 的原始消息和真实意图；
4. 保留已经完成的 Tool Call 和关键 Tool Result；
5. 对更早的 History 进行更激进的压缩；
6. 从失败的 LLM Dispatch 重新执行。

恢复边界应该是最后一个成功持久化的事件，而不是简单地回到“最后一轮”。

例如：

```text
User Message             已持久化
第一次 LLM Dispatch      成功
Tool Call                已持久化
Tool Result              已持久化
第二次 LLM Dispatch      Context Overflow
```

恢复时应保留 User Message、Tool Call 和 Tool Result，然后从第二次 LLM Dispatch 重试。对于具有副作用的工具，还需要设置幂等键，避免恢复过程中重复发送邮件、创建日程或执行支付。

---

## 九、Token Budget 与压缩阈值

Pre-turn 和 Agent Loop 内可以共用同一个预算检查框架，但由于需要预留的内容不同，具体参数不一定完全相同。

可以计算：

```text
effective_headroom =
模型 Context 上限
- 当前输入 Token
- 预留输出 Token
- 预计下一次 Tool Result
- Safety Buffer
```

例如，当满足任意条件时触发 Compact：

```text
剩余有效 Context 低于总窗口的 15%
或
effective_headroom 低于当前业务的最低安全 Token 数
```

比例阈值用于适配不同大小的模型窗口；绝对 Token 阈值用于保护可能产生大型 Tool Result 的 Coding Agent。具体数值不能脱离模型与业务固定为 50K，而应通过 Evals 确定。

---

## 十、通过 Evals 确定具体策略

压缩 Schema、保留字段、触发阈值和召回策略不应该只靠经验决定，而应该针对不同业务场景建立 Evals。

主要指标包括：

- 当前 Turn 意图还原准确率；
- 用户约束保留率；
- 指代解析准确率；
- 长程任务完成率；
- 工具选择和参数正确率；
- 历史检索命中率；
- 高风险事实核验率；
- Context Overflow 发生率；
- 平均 Token 成本；
- 首 Token 延迟和整体响应时间。

Evals 最终用于决定：

- 不同 Agent 使用什么摘要 Schema；
- 最近原文保留多少轮；
- 哪些信息必须逐字保留；
- Tool Result 保留多少、何时外置；
- 什么时候主动检索历史；
- Pre-turn 与 Agent Loop 内分别使用什么阈值；
- Overflow 时采用多激进的压缩策略。

---

## 总结

我的整体方案分为四个层面。

第一，明确区分 History Context 和 Active Turn：

- History Context 的压缩需要保证语义连续性和任务一致性；
- Active Turn 需要独立保证当前意图保真，不能被历史摘要覆盖。

第二，根据业务场景设计压缩结构：

- 陪伴聊天更加重视人物、关系、情绪和指代；
- Coding Agent 与长程任务更加重视目标、约束、状态和下一步动作；
- 高风险操作还必须保存精确参数、用户授权和原始证据。

第三，在压缩前先对信息进行分类：

- 当前意图和即时工作集直接保留；
- 金额、时间、授权等精确事实无损外置，并在需要时准确召回；
- 人物和实体关系存入适合的关系、事件或图存储；
- 任务状态进行结构化压缩；
- 一般历史进行语义摘要；
- 代码、日志和大型 Tool Result 存入 Artifact Store。

第四，在工程上通过 Pre-turn、Agent Loop 内每次 LLM Dispatch 前和 Context Overflow Recovery 三个检查点执行自动 Compact，并使用 Event Log、Checkpoint 和历史检索工具提供可追溯性。

最终原则是：

> **当前 Turn 决定现在做什么，History 中的语义连续性负责解释用户在说什么，任务一致性负责确保事情没有做偏。压缩可以丢失可恢复的历史细节，但不能改写当前意图、破坏任务状态，也不能让 Agent 在信息不足时依靠猜测。**

工程上可以进一步概括为：

> **触发压缩看 Token Budget，信息怎么处理看它的精度、风险、相关性和可恢复性，失败后从哪里恢复看持久化事件边界。**
