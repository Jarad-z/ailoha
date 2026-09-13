# 最小可用 Agent：Ailoha 端到端测试设计与执行记录

## 1. 测试边界

本仓库的确定性 E2E 以 `Session.agent.prompt()` 为公开入口，只替换不可控的模型边界，真实执行以下链路：

```text
用户输入
  → Session / Context 恢复
  → ScriptedModelRunner 决策
  → ToolManager 查找和 Schema 校验
  → calculator / search / weather 真实执行
  → ToolResult 回填 Context
  → 下一轮模型决策或最终回答
  → Session 历史提交
  → Trace 写入
```

测试文件：`packages/agent-tools/test/deterministic-e2e.test.ts`

原则：每个用例同时验证用户结果、工具行为、状态变化和 Trace，不只匹配最终答案。每一次完整
Agent 调用都必须满足以下 Trace 不变量：

1. 同一个 `runId + sessionId` 恰好有一个 `agent.run.started` 和一个 `agent.run.finished`；
2. `finished.sequence > started.sequence`，并记录非负 `durationMs`；
3. 每个 `tool.call.requested` 都按 `toolExecutionId + toolCallId` 对应一个 `tool.call.finished`；
4. 工具终止事件必须出现在工具请求之后；
5. 真实模型 HTTP E2E 的完整顺序必须是 `run.started → tool.requested → tool.started → tool.finished → run.finished`。

## 2. 场景矩阵

| 场景 | 入口与真实依赖 | 核心断言 | 状态 |
|---|---|---|---|
| 直接回答 | Session + Context + Trace | 最终回答存在；工具事件为 0 | 已覆盖 |
| calculator | 真实 calculator | 参数、161、ToolResult 回填、成功 Trace | 已覆盖 |
| search | 固定本地文档 + 真实 search | query、19.90、结果回填 | 已覆盖 |
| 第三个工具 | 固定天气数据 + 真实 weather | 上海、晴、26°C | 已覆盖 |
| 多步工具 | search → calculator | 调用顺序、19.90 跨轮传递、最终 59.70 | 已覆盖 |
| 纯对话追问 | 同一 Session 两次 prompt | Bluebird 的用户输入和助手确认均进入后续 Context | 已覆盖 |
| 历史工具结果追问 | 同一 Session 两次 prompt | 首轮 19.90 被第二轮读取并计算 99.50 | 已覆盖 |
| Session 隔离 | 两个 Session 并发 | 历史和 Trace 的 sessionId 均不串线 | 已覆盖 |
| Context 压缩召回 | 真实 ContextManager + 测试 Compactor | 压缩确实发生、旧原文移除、ORBIT-928/小林保留 | 已覆盖 |
| 非法工具调用（补充项） | 未知工具、缺失参数、修正调用 | 不计入本轮主验收；现有用例继续作为回归保护 | 已覆盖 |
| 最大轮次 | `maxTurns = 3` | 精确调用模型和工具各 3 次，然后抛出 `AgentTurnLimitError` | 已覆盖 |
| Trace 完整性与脱敏 | TraceRecorder + InMemory/JSONL Sink | 生命周期配对、ID、顺序、结果、敏感字段脱敏 | `agent-core/test/trace-e2e.test.ts` 已覆盖 |
| HTTP 黑盒 | 真实 Node HTTP Server + fetch | Profile/Session/Message/Run/Operation/Transcript/SSE | `agent-service/test/http-e2e.test.ts` 已覆盖 |
| 真实模型 HTTP E2E | 子进程 HTTP Server + DeepSeek + fetch + Trace SSE | 模型真实调用 calculator、Run 成功、答案与 Trace 一致、服务自动关闭 | `scripts/deepseek-http-e2e.mjs` 已覆盖 |
| 工具执行异常/取消 | Agent + 测试工具 | execution/cancelled/skipped Trace 与 Context 完整性 | `agent-core/test/agent.test.ts` 已覆盖 |
| Session 并发写入 | 同一 Session 两次 prompt | 第二个请求明确拒绝，不静默覆盖 | `agent-core/test/session-runtime.test.ts` 已覆盖 |

## 3. 与通用方案不同的产品语义

- Ailoha Core 的模型边界返回结构化 `AssistantMessage`，不在 Core 内解析模型生成的 JSON。因此“非法 LLM JSON 输出”应由未来的 Provider Adapter 测试，不能在 Core E2E 中伪造为已覆盖。
- 最大轮次使用 `maxTurns`，表示 Session 生命周期内允许的模型调用次数。达到上限时抛出结构化 `AgentTurnLimitError`，而不是返回 `status = degraded`。
- 默认 ContextManager 提供压缩事务和替换机制，具体 Token 预算与摘要算法由注入的 `Compactor` 决定。E2E 使用确定性 Compactor 验证 Runtime 的压缩后召回链路。
- search 和 weather 在确定性 E2E 中只使用本地 Fixture，不访问网络。

## 4. 尚未覆盖的边界

1. Provider Adapter 的原始响应解析：非法 JSON、半截 Tool Call、Provider 特有错误映射。
2. 自动 Token 估算和生产摘要质量：当前仓库只有可注入 Compactor，没有统一生产实现。
3. Vitest 测试报告中的真实 LLM 用例：当前真实模型 E2E 是独立 Node 黑盒脚本，不计入 Vitest 覆盖率和用例数。

这些缺口不影响确定性 Runtime 或真实模型 HTTP 闭环，但在交付独立 Provider Adapter 前应补齐第 1 项。

## 5. 执行命令

```powershell
# 只跑新增的确定性 Agent E2E
npm run test:e2e

# 类型检查
npm run check

# 全仓库回归
npm test

# 构建、启动临时 HTTP 服务、调用真实 DeepSeek、验证 Trace，并关闭服务
npm run test:e2e:live
```

真实 DeepSeek smoke test（仅在显式配置 Key 后执行）：

```powershell
npm run demo:deepseek:runtime
```

## 6. 2026-09-12 执行记录

- `npm run test:e2e`：9/9 通过；每个 Run 和 Tool Call 均通过统一 Trace 配对断言。
- `npm run check`：通过。
- `npm test`：134/134 通过（Core 98、Service 13、Tools 23；其中验收型 E2E 9 个）。
- `npm run test:e2e:live`：通过，进程退出码 0。
- 真实模型：`deepseek-v4-flash`。
- HTTP 闭环：创建 Profile/Session → 订阅 Trace SSE → 发送 Message → 轮询 Run → 读取 Transcript → 关闭服务。
- 模型行为：真实调用一次 `calculator`，计算 `12345 * 6789`，最终回答 `83810205`。
- Trace：5 个事件，Session/Run ID 一致、顺序完整，工具结果为 success。
