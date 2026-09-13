# 工具调用 API 的区别与优缺点

Claude Code 与模型交互时使用的 Anthropic Messages API，以及 OpenAI 的 Chat Completions、Responses API，可以沿着一次工具调用的过程来比较：先声明工具和调用范围，再接收模型生成的调用，最后执行工具并返回结果。

## 一、先把工具交给模型：调用范围与缓存

三种 API 都通过 `tools` 提供工具名称、描述和参数定义。区别在于，声明了很多工具后，怎样限制本轮只调用其中一部分。

比如一套工具既能读文件，也能写文件，但这一轮只允许读取。Messages 的普通自定义工具通常需要客户端过滤 `tools`，只提交允许调用的工具。这样比较直接，也能减少上下文占用；不过，每轮增删工具会改变提示词前缀，影响缓存命中。
claude messages api则会裁剪掉工具，破坏提示词前缀，导致缓存破坏。
当前 OpenAI 两种 API 都提供 `allowed_tools`，可以保留完整的工具定义，只调整本轮的可调用集合，更有利于复用缓存。

这里还要看具体平台：兼容 OpenAI 格式，不代表支持全部配置。推理强度等设置也可能影响缓存，claude就把思考强度的token放在提示词前面，所以每当切换思考强度时，缓存命中率就会被破坏，而gpt5.6还有gpt astra 模型就不会破坏缓存命中。实际影响取决于模型，不能只看 JSON 字段的位置判断。

## 二、模型决定调用工具后：输出结构与流式处理

**Messages API** 把文本、思考和工具调用放在有序的 `content[]` 中。工具调用是 `tool_use` 块，完整响应里的参数 `input` 已经是对象，应用拿来使用比较方便。不过，流式传输时，参数仍然是逐段到达的 JSON 文本，需要在 `content_block_stop` 后完成组装。因此，对象格式主要改善易用性，不能据此判断性能更好。[1]

**Chat Completions** 把文本放在 assistant 的 `content`，工具调用放在 `tool_calls[]`。参数 `arguments` 是 JSON 字符串，应用需要额外解析。它也支持边接收边按索引拼接调用，但标准流没有逐个调用的结束事件，通常等到 `finish_reason="tool_calls"` 再执行。它的优势是接口普及、适配方便，不足是单个调用的完成边界不如另外两种清晰。[2]

**Responses** 则把消息、推理和函数调用分别作为 item，放进有序的 `output[]`。参数同样需要 JSON 解析，但每个 item 有自己的事件边界：`response.output_item.done` 表示这个 item 已完成，`response.completed` 才表示整次响应结束。应用可以先执行已完整生成的调用，同时继续接收后续输出，代价是要处理更多事件和状态。Anthropic 也有块级完成边界，所以这一点并非 Responses 独有。[1][3]

## 三、拿到调用后：工具执行与服务端托管
Responses 还提供服务端搜索、会话续接和上下文压缩。采用这些能力后，应用侧 Agent Harness 要自己维护的逻辑会减少，开发更省事；相应地，对服务商的依赖更强，对托管功能内部细节的控制也更少。

[1]: https://platform.claude.com/docs/en/build-with-claude/streaming
[2]: https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events
[3]: https://developers.openai.com/api/reference/resources/responses/streaming-events
[4]: https://developers.openai.com/api/docs/guides/async-tool-calling
[5]: https://developers.openai.com/api/docs/guides/function-calling
[6]: https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching
[7]: https://developers.openai.com/api/docs/guides/compaction
[8]: https://platform.claude.com/docs/en/build-with-claude/compaction
[9]: https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
[10]: https://developers.openai.com/api/docs/guides/migrate-to-responses
