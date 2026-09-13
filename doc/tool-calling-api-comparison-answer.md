# Agent 技术笔试：工具调用 API 的区别与优缺点

> 题目：Claude Code 的工具输出方式与 OpenAI-compatible Function Calling 有什么不同？这些设计各自有什么优缺点？
>
> 本文从 Anthropic Messages API、OpenAI Chat Completions API 和 OpenAI Responses API 三种协议展开比较。能力与限制依据 2026 年 9 月 13 日查阅的官方文档。

首先需要区分产品和协议：Claude Code 是 Agent 应用，题目中的工具交互方式可以从 **Anthropic Messages API** 分析；OpenAI 的接口则需要区分 **Chat Completions API** 和 **Responses API**。对于普通自定义函数，三者的基本流程一致：模型生成调用请求，应用执行工具，再将结果返回模型。区别主要体现在协议表达、调用控制和平台承担的运行时职责上。

## 一、工具声明、调用范围与缓存策略

三种 API 都通过 `tools` 声明工具及参数结构，但“声明哪些工具”和“本轮允许调用哪些工具”的控制方式有所不同。

### 1. 允许调用的工具子集

Anthropic Messages API 的普通自定义工具通过 `tool_choice` 控制自动选择、必须调用工具、指定某个工具或禁止调用。对于任意多个工具组成的允许子集，通常由客户端过滤本次提交的 `tools`。这样实现直接，也能减少工具定义占用的上下文；但频繁增删工具会改变提示词前缀，影响缓存复用。[Anthropic 工具配置](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)

当前 OpenAI 的 Chat Completions 和 Responses 都提供 `allowed_tools` 配置，可以保持完整的 `tools` 定义不变，只改变本轮允许调用的子集。**其优势是将工具定义与调用策略分离，有利于维持缓存命中。** 更准确的表述是“限制可调用集合”，不应在缺乏证据时断言底层一定采用了某种 token 遮蔽算法。另外，第三方接口标注 OpenAI-compatible，并不意味着已经支持这些最新配置。[Chat Completions 参数](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[Function Calling 指南](https://developers.openai.com/api/docs/guides/function-calling)

### 2. 推理强度与缓存

推理强度也可能影响缓存，但需要结合模型实现判断，不能根据请求 JSON 中字段的前后位置推断：

- **Anthropic** 会将 thinking 配置和 effort 渲染进模型提示词。改变这些配置会使消息缓存失效；工具和系统提示词缓存是否也失效，取决于具体模型将配置放在哪里，不能一概称为“全部 KV cache 被破坏”。[Anthropic 缓存规则](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching)
- **Responses 配合 GPT-6 Astra**，可以保持请求级 `reasoning.effort` 不变，在后续输入中追加 `configuration_update`，调整推理强度并保留原有缓存前缀。这是有适用条件的具体能力，不能推广为“Chat Completions 和 Responses 改推理强度都不影响缓存”。[推理配置更新](https://developers.openai.com/api/docs/guides/reasoning#change-reasoning-mid-conversation)

## 二、工具调用的表达方式，以及平台承担多少运行时工作

### 1. 调用与结果的数据结构

三者最直观的结构区别如下：

| API | 模型输出的工具调用 | 调用参数 | 工具结果如何返回 |
| --- | --- | --- | --- |
| Anthropic Messages | `assistant.content[]` 中的 `tool_use` 块 | `input` 对象 | `user.content[]` 中的 `tool_result` |
| Chat Completions | assistant 消息的 `tool_calls[]` 字段 | `function.arguments`，JSON 字符串 | `role: "tool"` 消息 |
| Responses | `output[]` 中的独立 `function_call` item | `arguments`，JSON 字符串 | `input[]` 中的 `function_call_output` item |

以上结构可参照 [Anthropic 工具调用文档](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)、[Chat Completions 接口参考](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)和 [OpenAI Function Calling 指南](https://developers.openai.com/api/docs/guides/function-calling)。

Anthropic 的完整响应直接提供 `input` 对象，应用使用起来更方便；另两者通常需要对 `arguments` 再做一次 JSON 解析。但这主要是接口易用性的差异，不能据此推断调用质量或性能存在明显差距。Anthropic 在流式传输时，同样会发送参数的 JSON 字符串增量。[流式参数说明](https://platform.claude.com/docs/en/build-with-claude/streaming)

### 2. 从消息字段到独立 item

从协议组织上看，Chat Completions 以消息为中心，将文本和工具调用放在不同字段；Anthropic 在消息内部使用有序内容块；Responses 则将 `message`、`reasoning`、`function_call` 等作为同一层级的不同 item。

**从工程设计上理解，这使 Responses 更便于统一表达对话内容和执行过程，并为不同操作提供独立的标识、状态和流式事件。** 代价是客户端需要处理更多 item 类型和状态。这是对协议设计的分析，不能仅凭 JSON 嵌套层级判断调用能力的高低。[Messages 与 Items 的官方比较](https://developers.openai.com/api/docs/guides/migrate-to-responses)

### 3. 并列结构与异步执行需要区分

**结构上的并列不等于执行上的并行。** Anthropic 也能流式输出工具块，不能说它必须生成完整消息后，客户端才能开始处理工具调用。[Anthropic 流式消息](https://platform.claude.com/docs/en/build-with-claude/streaming)

真正的异步能力需要模型、协议和应用调度共同支持。例如，GPT-6 Astra 的 Responses 工具可以设置 `async: true`，让模型在工具结果尚未返回时继续推理、调用其他工具或回答独立问题。这可以重叠工具等待时间；但自定义工具仍由应用执行，应用也仍需维护未完成任务和结果对应关系。[异步工具调用](https://developers.openai.com/api/docs/guides/async-tool-calling)

### 4. 服务端能力与 Agent Harness 的取舍

Responses 的另一项优势，是可以将更多运行时职责交给服务端，例如内置 Web Search、会话续接和上下文压缩。采用这些能力后，应用的 Agent Harness 可以减少自行实现的工具循环和上下文管理逻辑。[Responses 能力](https://developers.openai.com/api/docs/guides/migrate-to-responses)、[服务端压缩](https://developers.openai.com/api/docs/guides/compaction)

这种设计的工程取舍是：开发成本降低，但对服务商实现的依赖增加，对内置操作的执行细节、压缩策略和状态表示的控制也相对减少。Responses 仍支持自定义工具，所以不能说它“缺少自定义能力”。

同时，Anthropic Messages 也提供服务端工具和服务端压缩，因此这些能力应按具体实现比较，不能视为 Responses 独有。[Anthropic 服务端工具与缓存](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching)、[Anthropic 服务端压缩](https://platform.claude.com/docs/en/build-with-claude/compaction)
