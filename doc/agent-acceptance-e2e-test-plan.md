# Ailoha Agent 验收 E2E 测试方案

## 1. 目标与边界

本方案验证 Agent 从用户输入到最终回复的完整 Loop，以及工具、Session、Context、异常和 Trace。测试分三层：

1. 确定性 E2E：使用真实 Session、Context、ToolManager、内置工具和 Trace，只替换不可控的 LLM 边界。
2. Provider Adapter 集成：从 OpenAI-compatible SSE 原始分片开始，验证请求 Schema 和响应解析。
3. 真实模型 HTTP 黑盒：启动本地 Agent Service，真实调用 DeepSeek，并从 HTTP、Transcript 和持久化 Trace 三个观察面交叉验证。

不把“最终回答包含某个字符串”作为唯一通过条件。工具调用类用例必须同时验证工具名称、参数、结果回填、Session/Run ID 和 Trace 生命周期。

## 2. 核心不变量

- 每个 Run 恰好有一个 `agent.run.started` 和一个终态 `agent.run.finished`。
- 每个 `tool.call.requested` 按 `sessionId + runId + toolExecutionId + toolCallId` 对应一个 `tool.call.finished`。
- 工具调用按 `requested → started → finished` 排序，最终回答只能出现在工具结果回填后的 LLM 轮次。
- 相同用户的不同窗口使用不同 Session；聊天历史、有状态工具实例和 Trace 都不得跨 Session。
- Context 压缩以事务方式替换历史：删除旧的冗长原文，同时保留测试指定的关键事实。
- 达到 `maxTurns` 后不得再调用 LLM 或工具，Run 以结构化错误结束。
- Trace 与测试产物不得包含 API Key。

## 3. 用例矩阵

| ID | 场景 | 输入/前置 | 关键断言 | 测试层 |
|---|---|---|---|---|
| AC-01 | 直接回复 | 普通知识问题 | 返回 final text；工具事件为 0 | 确定性 E2E |
| AC-02 | 工具注册与 Schema 可见性 | 注册 calculator/search/weather/todo | 每个工具有 name、description、object parameter Schema；Adapter 原样传给 LLM | 确定性 + Adapter |
| AC-03 | 三类工具 | 算式、商品查询、上海天气 | calculator=161；search=19.90；weather=晴/26°C；结果均进入下一轮 Context | 确定性 E2E |
| AC-04 | 多步 Loop | 搜价格后计算 3 件总价 | 调用顺序 search→calculator；跨轮使用 19.90；final=59.70 | 确定性 E2E |
| AC-05 | LLM 输出解析 | SSE reasoning + 分片 tool_calls + final text | 提取 thinking/tool call/final；工具参数为对象；下一轮重放 reasoning、tool call、tool result | Adapter 集成 |
| AC-06 | 双窗口 Session 隔离 | 窗口 1 保存日历事项；窗口 2 保存联系人 | 两个 Session 并发；各自列表只含本窗口数据；历史、工具状态和 Trace ID 不串线 | 确定性 E2E |
| AC-07 | 纯对话追问 | 先记住 Bluebird，再询问代号 | 第二次模型 Context 含首轮用户和助手消息；无需工具 | 确定性 E2E |
| AC-08 | 工具型追问 | 首轮 search 单价，追问 5 件总价 | 第二个 Run 读取历史 ToolResult 并调用 calculator；final=99.50 | 确定性 E2E |
| AC-09 | Context 压缩 | 关键事实 + 超长填充 + 追问 | 发生一次压缩；旧原文移除；ORBIT-928/小林仍可召回 | 确定性 E2E |
| AC-10 | 最大 Loop 轮次 | 模型持续请求 calculator，maxTurns=3 | 精确 3 次 LLM/工具调用；随后抛 `AgentTurnLimitError`；无第 4 次调用 | 确定性 E2E |
| AC-11 | 异常恢复 | unknown tool → 缺参数 → 合法调用 | lookup/validation 错误转为 ToolResult；模型可修正；最终成功；另覆盖执行/取消 | 确定性 + Core |
| AC-12 | Trace/日志 | 成功、失败、取消、多 Session | 生命周期完整、事件有序、ID 一致、敏感字段脱敏、JSONL 可持久化 | Core + Service |
| AC-13 | HTTP 黑盒 | 创建 Profile/Session、发消息、轮询 Run | Run/Operation/Transcript/SSE/NDJSON 均可查询且授权隔离 | Service E2E |
| AC-14 | 真实模型自主选工具 | 同时提供 calculator/search/weather，要求精确计算 | LLM 基于 Schema 只选择 calculator；答案 83810205；SSE Trace 与持久化 JSONL 一致 | 真实模型 E2E |
| AC-15 | `AGENTS.md` 真实模型记忆与 workspace | 随机 marker、文件热更新、工具 Loop、双 Session、HTTP workspaceId | 指令进入 system message 并被模型执行；跨 Run 重新加载；Session/workspace 不串线；正文不进入 Transcript | 真实模型 E2E |

## 4. Context 纳入策略

- 纳入：用户消息、助手的文本/思考块/工具调用、工具执行结果，以及压缩后的摘要状态。
- 不写入会话 Transcript：运行时系统提示、工作区指令文件本身和 Trace 内部元数据。
- 思考块只验证结构化提取和同模型协议重放，不在报告中复制真实模型的完整思考内容。
- 压缩测试使用确定性摘要器，避免把摘要质量和 Runtime 的提交语义混为同一个变量。

## 5. 执行与产物

执行：

```powershell
npm run test:acceptance
```

脚本依次执行类型检查、构建、全量 Vitest 回归、真实 DeepSeek HTTP E2E 和 `AGENTS.md` workspace 真实模型 E2E。产物保存在 `artifacts/agent-acceptance/<UTC 时间>/`，包括：

- 每一步原始日志；
- 机器可读 `manifest.json`；
- `test-report.md`；
- 真实模型 `live-http-summary.json`、`live-http-trace.jsonl` 和 `live-http-transcript.json`。
- `workspace-agents-md-live-e2e-summary.json` 与 JSONL 逐事件证据。

`artifacts/agent-acceptance/latest.json` 和 `latest-report.md` 指向最近一次执行结果。未配置 `DEEPSEEK_API_KEY` 时，真实模型用例会明确标记为 skipped，而不会伪装成通过。
