# Chat Completions Adapter E2E Trace 报告

## 1. 报告摘要

本报告说明 `@ailoha/chat-completions-adapter` 在一次真实 DeepSeek Agent ReAct 运行中产生的端到端 trace。原始数据位于 [`artifacts/chat-completions-adapter-e2e-trace.jsonl`](../artifacts/chat-completions-adapter-e2e-trace.jsonl)，由 `scripts/deepseek-adapter-e2e-trace.mjs` 生成。

本次运行成功完成了下面的完整闭环：

```text
用户请求
→ 第一次 Chat Completions streaming 调用
→ provider reasoning
→ calculator tool call
→ Agent Core 执行 calculator
→ 第二次 Chat Completions streaming 调用
→ 回放 reasoning、tool call 与 tool result
→ 最终文本回答
```

关键结论：

- Run ID：`adapter_e2e_1789224169543`
- 调用模型：请求模型 `deepseek-v4-flash`，provider 返回模型 `deepseek-flash`
- 模型 HTTP 调用：2 次
- 工具执行：1 次，成功
- Trace 记录：76 条
- Agent 总耗时：约 1812 ms
- 最终答案：`(137 × 42) + 19 的结果是 5773。`
- Trace 不含 API key，也不含 Authorization header

## 2. Trace 的物理格式

Trace 使用 JSONL：一行一个完整 JSON object。这样可以流式追加、逐行检索，也可以在进程异常时尽量保留已经写入的记录。

每条记录都有统一的外层时间线字段：

```json
{
  "sequence": 52,
  "elapsedMs": 928,
  "type": "model.request",
  "source": "chat-completions-adapter",
  "modelCall": 2
}
```

字段含义：

| 字段 | 含义 |
| --- | --- |
| `sequence` | 本次 E2E 运行中的全局递增序号，可跨 Agent、模型和工具事件排序 |
| `elapsedMs` | 相对脚本启动时刻的毫秒数 |
| `type` | 记录类型，如 `model.request`、`model.stream.event`、`tool.call.finished` |
| `source` | 事件来源；本次包括 `agent-core`、`chat-completions-adapter` 和 `script` |
| `modelCall` | 第几次模型调用；仅模型相关记录存在 |

Agent Core 自己的 trace event 被原样放在外层记录的 `event` 字段中，因此它仍保留 `schemaVersion`、`eventId`、`sessionId`、`runId`、`correlationId` 和 Core 内部的 `sequence`。外层 `sequence` 负责把 Core 事件与 adapter 事件合并成一条总时间线。

## 3. 事件组成

76 条记录的顶层分布如下：

| 事件类型 | 数量 | 说明 |
| --- | ---: | --- |
| `agent.run.started` | 1 | Agent run 开始 |
| `model.request` | 2 | 两次实际 Chat Completions 请求 payload |
| `model.response` | 2 | 两次 HTTP response 元数据 |
| `model.stream.event` | 64 | adapter 输出的 Pi `AssistantMessageEvent` 流 |
| `model.result` | 2 | 每次模型调用聚合后的最终 `AssistantMessage` |
| `tool.call.requested` | 1 | Agent 观察到模型请求调用 calculator |
| `tool.call.started` | 1 | calculator 开始执行 |
| `tool.call.finished` | 1 | calculator 执行完成 |
| `agent.run.finished` | 1 | Agent run 成功结束 |
| `e2e.result` | 1 | 脚本汇总的最终运行结果 |

这里的 `model.stream.event` 不是原始 SSE 文本帧，而是 OpenAI SDK 完成 HTTP、SSE 解帧和 JSON 解码后，由 adapter 转换出的 Pi 事件。换句话说，它观察的是应用真正消费的语义事件，而不是底层网络 byte chunk。

## 4. 精确时间线

本次调用发生于 2026-09-12 22:42:49（Asia/Shanghai）。关键节点如下：

| 全局序号 | 相对时间 | 事件 | 结果 |
| ---: | ---: | --- | --- |
| 1 | 4 ms | `agent.run.started` | Agent run 开始 |
| 2 | 5 ms | 第一次 `model.request` | 发送 system、user 和 calculator schema |
| 3 | 346 ms | 第一次 `model.response` | HTTP 200，`text/event-stream` |
| 4 | 346 ms | 第一次 stream `start` | adapter 开始接收 typed chunks |
| 5 | 751 ms | `thinking_start` | 建立 `ThinkingContent`，index 0 |
| 27 | 877 ms | `toolcall_start` | 建立 calculator `ToolCall`，index 1 |
| 45–47 | 925 ms | block end + `done` | 第一次调用以 `toolUse` 完成 |
| 48 | 925 ms | 第一次 `model.result` | 得到 reasoning + tool call |
| 49–51 | 926–928 ms | 工具生命周期 | calculator 成功返回 5773 |
| 52 | 928 ms | 第二次 `model.request` | 回放 assistant reasoning、tool call 和 tool result |
| 53 | 1264 ms | 第二次 `model.response` | HTTP 200，`text/event-stream` |
| 54 | 1264 ms | 第二次 stream `start` | adapter 开始接收第二次 typed chunks |
| 55 | 1772 ms | `text_start` | 建立最终 `TextContent`，index 0 |
| 72–73 | 1816 ms | `text_end` + `done` | 第二次调用以 `stop` 完成 |
| 74 | 1816 ms | 第二次 `model.result` | 得到最终文本答案 |
| 75 | 1816 ms | `agent.run.finished` | outcome=`success` |
| 76 | 1816 ms | `e2e.result` | 脚本输出最终汇总 |

时间上可以看出：第一次请求约 341 ms 收到 HTTP response，第一次模型阶段在 925 ms 完成；工具实际执行约 1.47 ms；第二次请求约 336 ms 收到 HTTP response，整个 Agent run 在约 1.812 秒结束。

## 5. 第一次模型调用

第一次 `model.request` 是一个标准 streaming Chat Completions payload：

- URL：`POST https://api.deepseek.com/chat/completions`
- `model`：`deepseek-v4-flash`
- `stream`：`true`
- `n`：`1`
- `stream_options.include_usage`：`true`
- Messages：system prompt + 用户问题
- Tools：calculator 的 function schema

模型没有直接给最终答案，而是先输出 provider 公开的 reasoning，再生成 calculator 工具调用：

```json
{
  "type": "toolCall",
  "id": "call_00_BYb6KVNmTjK5ZcoDvdrL8473",
  "name": "calculator",
  "arguments": {
    "expression": "(137 * 42) + 19"
  }
}
```

第一次 stream 的事件分布：

| 事件 | 数量 |
| --- | ---: |
| `start` | 1 |
| `thinking_start` / `thinking_end` | 各 1 |
| `thinking_delta` | 21 |
| `toolcall_start` / `toolcall_end` | 各 1 |
| `toolcall_delta` | 17 |
| `done` | 1 |

21 个 reasoning delta 最终聚合为一个 73 字符的 `ThinkingContent`，`thinkingSignature` 为 `reasoning_content`。17 个 tool-call delta 最终聚合出 33 字符的 arguments JSON，并在 `toolcall_end` 前严格解析为 JSON object。

第一次模型结果：

- `stopReason`：`toolUse`
- 原始 `finish_reason`：`tool_calls`
- `responseId`：`276edb3e-8862-4f56-8467-6e0b78a0d750`
- `responseModel`：`deepseek-flash`
- Content 顺序：`ThinkingContent[0]` → `ToolCall[1]`

这个顺序说明 adapter 按 block 第一次出现在响应流中的顺序分配了稳定 `contentIndex`，没有在 finalize 时重新排序。

## 6. 工具执行

Agent Core 在第一次 `AssistantMessage` 完成后才把消息加入 Context，然后观察到 calculator tool call。工具 trace 使用同一个 `runId` 和 `correlationId` 串联三个阶段：

```text
tool.call.requested
→ tool.call.started
→ tool.call.finished(outcome=success)
```

输入参数：

```json
{ "expression": "(137 * 42) + 19" }
```

工具结果：

```json
{
  "content": "{\"expression\":\"(137 * 42) + 19\",\"result\":5773}"
}
```

工具执行总耗时约 2.79 ms，其中实际执行约 1.47 ms。执行成功后，Agent Core 创建 `ToolResultMessage` 并发起下一次模型调用。

## 7. 第二次模型调用与上下文回放

第二次 `model.request` 是验证 adapter 上下文转换正确性的关键证据。它包含四条 message：

1. 原 system prompt。
2. 原 user message。
3. 第一次 assistant message：`content: null`、完整 `tool_calls`，以及同名 `reasoning_content`。
4. calculator 的 tool result：通过 `tool_call_id` 与前面的调用关联。

其中 assistant replay 的关键形状是：

```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [
    {
      "type": "function",
      "id": "call_00_BYb6KVNmTjK5ZcoDvdrL8473",
      "function": {
        "name": "calculator",
        "arguments": "{\"expression\":\"(137 * 42) + 19\"}"
      }
    }
  ],
  "reasoning_content": "<provider 公开的 reasoning 文本>"
}
```

这证明：

- thinking 没有被错误拼进普通 assistant `content`；
- tool arguments 被重新序列化为 Chat Completions 要求的 JSON string；
- reasoning 只通过其原 `thinkingSignature` 字段回放；
- tool result 没有伪装成 user message，而是正确使用 `role: "tool"`；
- `tool_call_id` 与第一次模型产生的 call id 完全一致。

第二次 stream 只产生文本：16 个 `text_delta` 被聚合为一个 26 字符的 `TextContent`，最终以 `finish_reason=stop` 正常结束。

## 8. Usage 分析

| 调用 | Fresh input | Cache read | Output | Reasoning | Adapter total |
| --- | ---: | ---: | ---: | ---: | ---: |
| 第一次 | 374 | 0 | 66 | 21 | 440 |
| 第二次 | 213 | 256 | 17 | 0 | 486 |
| 合计 | 587 | 256 | 83 | 21 | 926 |

说明：

- `reasoning` 是 output 的子集，不能再加到 total 中。
- 第二次调用命中了 256 个 cache-read tokens，说明历史上下文回放被 provider 缓存利用。
- Adapter 按 spec 只归一化 usage，不负责定价，因此 trace 中所有 cost 字段为 0；这不是免费调用的含义。

## 9. 成功与一致性证据

这份 trace 同时证明了以下协议性质：

- 每次请求都固定使用 `stream: true` 和 `n: 1`。
- 每次成功模型流只有一个 terminal `done`，没有 `error`。
- `finish_reason` 到 Pi stop reason 的映射正确：`tool_calls → toolUse`，`stop → stop`。
- 第一次模型消息包含 reasoning 和 tool call，并在完整 stream 结束后才成为 `model.result`。
- Agent 在第一次 `model.result` 后才执行工具，没有把 streaming partial message 提前写入 ReAct history。
- 第二次请求完整回放第一次 assistant message 和 tool result。
- 两次模型结果、工具事件和 Agent run 都由同一个 run/correlation 链路关联。
- 最终 message roles 为 `user → assistant → toolResult → assistant`。

## 10. 安全与可观测性边界

生成 trace 后执行了敏感信息扫描：

```json
{
  "containsApiKey": false,
  "containsAuthorization": false
}
```

Trace 有意记录：

- typed request payload；
- HTTP status 和安全的 response 元数据；
- token-level/fragment-level Pi events；
- 最终 `AssistantMessage`；
- Agent 和工具生命周期。

Trace 有意不记录：

- API key；
- Authorization header；
- 完整请求 headers；
- 原始网络 byte chunks；
- OpenAI SDK 内部 SSE parser 状态；

因此，这是一份“应用语义层 E2E trace”：足够重建一次模型调用如何进入 Agent、产生工具、回放上下文并完成答案，同时不把 transport credential 写入持久化记录。

## 11. 结论

本次真实运行展示了 adapter 的核心价值：它把 OpenAI Chat Completions wire protocol 与 Pi/Agent Core 的消息模型连接起来，但没有把 provider registry、工具执行或 Agent 生命周期耦合进 adapter。

从 trace 可以明确看到两个边界：

```text
OpenAI SDK / provider chunks
→ ChatCompletionsAdapter
→ Pi AssistantMessageEvent / AssistantMessage
→ Agent Core
→ Tool execution
→ 下一轮 Context
```

本次 E2E 的两次模型调用、reasoning 保存与回放、工具参数聚合、工具结果回放、usage 归一化和最终停止原因均符合 spec，且完整链路在约 1.812 秒内成功结束。
