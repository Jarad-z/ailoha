# Ailoha Agent 验收测试报告

- 总体结果：**passed**
- 开始时间：2026-09-13T05:25:40.036Z
- 结束时间：2026-09-13T05:26:12.168Z
- Git revision：`ff132090dad171f1fb2d420d02f9bd957687c854`（工作区有未提交改动）
- Node：v22.23.2
- 确定性测试：239 个测试通过，25 个测试文件通过
- 真实模型 E2E：通过
- AGENTS.md 真实模型 E2E：通过

## 执行结果

| 步骤 | 内容 | 状态 | Exit code | 耗时 | 原始日志 |
|---|---|---:|---:|---:|---|
| 01-typecheck | TypeScript 静态检查 | passed | 0 | 1.03s | [01-typecheck.log](./01-typecheck.log) |
| 02-build | 全 workspace 构建 | passed | 0 | 2.51s | [02-build.log](./02-build.log) |
| 03-regression | 全量确定性回归与 E2E | passed | 0 | 10.26s | [03-regression.log](./03-regression.log) |
| 04-live-http-e2e | 真实 DeepSeek HTTP 黑盒 E2E | passed | 0 | 6.44s | [04-live-http-e2e.log](./04-live-http-e2e.log) |
| 05-agents-md-live-e2e | 真实 DeepSeek AGENTS.md workspace E2E | passed | 0 | 11.88s | [05-agents-md-live-e2e.log](./05-agents-md-live-e2e.log) |

## 需求覆盖矩阵

| ID | 验收场景 | 结果 | 主要证据 |
|---|---|---:|---|
| AC-01 | 直接回复且不调用工具 | 通过 | agent-tools/deterministic-e2e |
| AC-02 | 工具注册：名称、描述、参数 Schema，并传给模型 | 通过 | agent-tools/tools + adapter/request |
| AC-03 | calculator、Mock search、weather 三工具执行与结果回填 | 通过 | agent-tools/deterministic-e2e |
| AC-04 | search → calculator 多轮 Loop 与数据传递 | 通过 | agent-tools/deterministic-e2e |
| AC-05 | 解析 thinking、tool call、final answer，并在下一轮重放 | 通过 | chat-completions-adapter/integration |
| AC-06 | 同一用户两个窗口的 Session 历史、Trace、有状态工具隔离 | 通过 | agent-tools/deterministic-e2e |
| AC-07 | 纯对话追问读取已提交历史 | 通过 | agent-tools/deterministic-e2e |
| AC-08 | 需要工具的追问复用历史工具结果 | 通过 | agent-tools/deterministic-e2e |
| AC-09 | Context 过长触发基础压缩并保留关键事实 | 通过 | agent-tools/deterministic-e2e + agent-core/context-compaction |
| AC-10 | 达到 maxTurns 后精确终止无限工具 Loop | 通过 | agent-tools/deterministic-e2e |
| AC-11 | 未知工具、Schema 校验失败、执行/取消异常 | 通过 | agent-tools/deterministic-e2e + agent-core/agent |
| AC-12 | Run/LLM/Tool Trace 生命周期、配对、顺序与脱敏 | 通过 | agent-core/trace-* |
| AC-13 | HTTP Profile/Session/Message/Run/Transcript/SSE 黑盒链路 | 通过 | agent-service/http-e2e |
| AC-14 | 真实 LLM 在三套工具 Schema 中自主选择 calculator 并闭环 | 通过 | scripts/deepseek-http-e2e.mjs |
| AC-15 | 真实 LLM 执行 AGENTS.md 注入、热更新、工具 Loop、Session/workspace 隔离和 HTTP allowlist | 通过 | scripts/deepseek-workspace-agents-md-live-e2e.mjs |

## 判定说明

确定性 E2E 使用真实 Session、Context、工具实现和 Trace，仅把不稳定的模型边界替换为脚本化响应；Adapter 集成测试从 OpenAI-compatible SSE 原始分片开始，覆盖思考块、工具调用参数和最终文本解析。真实模型 E2E 则通过本地 HTTP 服务走完整 Profile → Session → Message → Run → LLM → Tool → LLM → Transcript/Trace 链路，并让模型同时看到 calculator、search、weather 三个工具的 Schema。

## 测试产物

- `manifest.json`：机器可读的环境、命令、耗时和退出码。
- `01-typecheck.log`、`02-build.log`、`03-regression.log`、`04-live-http-e2e.log`、`05-agents-md-live-e2e.log`：原始执行日志。
- `live-http-summary.json`：真实模型、Session、Run、候选工具、实际工具和答案摘要。
- `live-http-trace.jsonl`：真实 Run 的持久化 Trace。
- `live-http-transcript.json`：真实 HTTP Session Transcript。
- `workspace-agents-md-live-e2e-summary.json`：AGENTS.md 真实模型案例汇总。
- `workspace-agents-md-live-e2e.jsonl`：请求投影、Provider 证据、Agent Trace 和逐案例断言。

详细用例设计见 [Agent 验收 E2E 测试方案](../../../doc/agent-acceptance-e2e-test-plan.md)。
