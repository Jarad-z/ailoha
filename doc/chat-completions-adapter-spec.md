# Minimal OpenAI Chat Completions Adapter Spec

状态：Draft v0.2

## 1. 目标

实现一个由 Ailoha 自己维护的最小 OpenAI Chat Completions adapter，不再调用 Pi 的 Chat Completions adapter、provider registry 或 compat API，同时继续沿用 Pi 的模型和消息类型。

MVP 必须支持：

- 把 Pi `Context` 转换为 OpenAI Chat Completions 请求。
- 通过 OpenAI SDK 发起 `stream: true` 请求并消费 SDK 解析后的 `ChatCompletionChunk`。
- 把 `delta.content` 转换为 Pi `TextContent`，作为最终答案。
- 从兼容服务公开的 reasoning 字段提取思考过程并转换为 Pi `ThinkingContent`。
- 把流式 `delta.tool_calls` 聚合为一个或多个 Pi `ToolCall`。
- 把 provider usage 和 `finish_reason` 转换为 Pi `Usage` 和 `StopReason`。
- 输出使用 Pi `AssistantMessageEvent` 形状的增量事件。
- 最终返回一个 Pi `AssistantMessage`，供现有 `ModelRunner` 和 Agent ReAct loop 使用。
- 支持取消，并在失败时保留已经生成的部分内容。

本 adapter 的含义是“OpenAI Chat Completions wire protocol adapter”，不是 provider 注册系统。模型目录、OAuth、动态 provider、provider 登录和模型发现不属于本模块。

## 2. 依赖边界

新模块可以通过 `import type` 复用以下 Pi 类型：

```ts
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	ImageContent,
	Message,
	Model,
	ProviderHeaders,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "@earendil-works/pi-ai";

import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionChunk,
	ChatCompletionCreateParamsStreaming,
	ChatCompletionMessageParam,
	ChatCompletionMessageToolCall,
	ChatCompletionTool,
} from "openai/resources/chat/completions.js";
```

MVP 不得导入或调用：

```text
@earendil-works/pi-ai/compat
@earendil-works/pi-ai/api/openai-completions
@earendil-works/pi-ai/api/openai-completions.lazy
@earendil-works/pi-ai/providers/*
createProvider()
createModels()
completeSimple()
streamSimple()
```

MVP 使用 OpenAI SDK 处理 HTTP、SSE 解帧、JSON 解码和标准 Chat Completions 类型。新 package 必须把 SDK 声明为直接依赖并固定到仓库当前版本：

```json
{
	"dependencies": {
		"@earendil-works/pi-ai": "0.85.1",
		"openai": "6.40.0"
	}
}
```

不得依赖 `pi-ai` 间接带入的 OpenAI SDK；adapter 必须拥有自己使用的直接依赖。

类型所有权：

```text
Model / Context / Message / content blocks / events → 继续复用 Pi 类型
Chat Completions 请求、chunk 和标准错误类型       → OpenAI SDK
HTTP、SSE 解帧和 JSON 解码                        → OpenAI SDK
事件队列与最终 result Promise                    → Ailoha adapter 自己实现
Chat Completion chunk 聚合                       → Ailoha adapter 自己实现
工具执行                                         → Agent Core，adapter 不执行工具
```

## 3. 包和文件布局

新增 workspace package：

```text
packages/chat-completions-adapter/
├── package.json
├── tsconfig.build.json
├── src/
│   ├── index.ts
│   ├── adapter.ts
│   ├── event-stream.ts
│   ├── request.ts
│   ├── response-accumulator.ts
│   └── types.ts
└── test/
    ├── adapter.test.ts
    ├── request.test.ts
    └── response-accumulator.test.ts
```

包名：

```json
{
	"name": "@ailoha/chat-completions-adapter"
}
```

`agent-core` 不依赖该包。具体应用或 service composition root 同时依赖 `agent-core` 和 adapter，然后把 adapter 包装成 `ModelRunner`。这样 `agent-core` 继续保持 provider-independent。

## 4. 对外接口

### 4.1 Adapter

```ts
export interface ChatCompletionsAdapterOptions {
	readonly model: Model<Api>;
	readonly apiKey: string;
	readonly headers?: ProviderHeaders;
	readonly fetch?: typeof globalThis.fetch;
	readonly timeoutMs?: number;
	readonly includeUsage?: boolean;
	readonly reasoningFields?: readonly ReasoningField[];
}

export interface ChatCompletionsRunOptions {
	readonly signal: AbortSignal;
	readonly temperature?: number;
	readonly maxTokens?: number;
	readonly toolChoice?: "auto" | "none" | "required";
	readonly onPayload?: (
		payload: ChatCompletionCreateParamsStreaming,
	) => ChatCompletionCreateParamsStreaming | undefined | Promise<ChatCompletionCreateParamsStreaming | undefined>;
	readonly onResponse?: (response: {
		readonly status: number;
		readonly headers: Readonly<Record<string, string>>;
	}) => void | Promise<void>;
}

export interface AssistantEventStream extends AsyncIterable<AssistantMessageEvent> {
	result(): Promise<AssistantMessage>;
}

export class ChatCompletionsAdapter {
	constructor(options: ChatCompletionsAdapterOptions);

	stream(context: Context, options: ChatCompletionsRunOptions): AssistantEventStream;

	complete(context: Context, options: ChatCompletionsRunOptions): Promise<AssistantMessage>;
}
```

`complete()` 必须通过同一条 streaming 实现完成：

```ts
complete(context: Context, options: ChatCompletionsRunOptions): Promise<AssistantMessage> {
	return this.stream(context, options).result();
}
```

不得为 `complete()` 再实现一条 `stream: false` 路径，否则两条响应解析逻辑会发生漂移。

### 4.2 Agent Core 接入

现有 `ModelRunner` 保持不变：

```ts
const adapter = new ChatCompletionsAdapter({
	model,
	apiKey,
});

const session = await Session.create({
	model,
	createModelRunner: () => ({
		run: (context, { signal }) => adapter.complete(context, { signal }),
	}),
});
```

当前 `ModelRunner.run()` 只返回最终 `AssistantMessage`，所以此接入方式虽然使用 streaming HTTP，但 Agent、Trace 和 UI 暂时只能看到最终消息。

把 `AssistantMessageEvent` 实时暴露给 Agent/UI 需要单独扩展 `ModelRunner` 或增加 model-event sink。这个 Core 接口变化不属于本 adapter MVP，不得为了完成 adapter 顺带修改 Agent loop。

## 5. 请求协议

### 5.1 URL

SDK client 使用：

```ts
const client = new OpenAI({
	apiKey,
	baseURL: model.baseUrl.replace(/\/+$/u, ""),
	defaultHeaders: normalizedHeaders,
	fetch: customFetch,
	maxRetries: 0,
	timeout: timeoutMs,
});
```

实际请求由 `client.chat.completions.create()` 发送到 `<baseURL>/chat/completions`。

调用方负责让 `model.baseUrl` 包含正确的 API 前缀，例如：

```text
https://api.openai.com/v1
https://api.deepseek.com
http://localhost:8000/v1
```

adapter 不猜测或自动补充 `/v1`。

### 5.2 Headers

Authorization、Accept 和 Content-Type 由 OpenAI SDK 生成。adapter 通过 SDK 的 `apiKey` 和 `defaultHeaders` 配置请求，不自己拼接 Authorization header。

构造时执行同步校验：

- `apiKey.trim()` 不能为空。
- `model.id`、`model.provider`、`model.api` 和 `model.baseUrl` 不能为空。
- `baseUrl` 必须能被 `URL` 解析。

自定义 headers 可以增加 provider 所需字段，但 MVP 不允许覆盖 `authorization`、`accept` 和 `content-type`，避免调用方意外破坏 SDK 鉴权或 streaming 协议。header name 比较不区分大小写；`ProviderHeaders` 中值为 `null` 的条目不传给 SDK。

API key、Authorization header 和完整请求 headers 不得写入日志、Trace、错误消息或测试快照。

### 5.3 Request body

请求使用 SDK `ChatCompletionCreateParamsStreaming` 类型：

```ts
const payload: ChatCompletionCreateParamsStreaming = {
	model: model.id,
	messages,
	stream: true,
	n: 1,
	stream_options: includeUsage ? { include_usage: true } : undefined,
	tools: tools.length > 0 ? tools : undefined,
	tool_choice: options.toolChoice,
	temperature: options.temperature,
	max_tokens: options.maxTokens,
};
```

规则：

- 永远发送 `stream: true` 和 `n: 1`。
- `includeUsage !== false` 时发送 `stream_options: { include_usage: true }`。
- `context.tools` 非空时发送 `tools`。
- `context.tools` 为空时省略 `tools`，不发送空数组。
- `maxTokens` 映射到 `max_tokens`。`max_completion_tokens` 等兼容差异不属于 MVP。
- `temperature` 只在调用方明确提供时发送。
- `onPayload` 可以替换最终 typed payload；回调抛错属于 request setup error。

## 6. Pi Context 到 Chat Completions messages

### 6.1 System prompt

`context.systemPrompt` 非空时生成第一条：

```ts
{
	role: "system",
	content: context.systemPrompt,
}
```

MVP 不实现 `developer` role 自动探测。

### 6.2 UserMessage

字符串内容转换为：

```ts
{
	role: "user",
	content: message.content,
}
```

数组内容中的 `TextContent` 按顺序拼接，中间用换行分隔。

MVP 不支持 `ImageContent`。遇到 user image 时必须在发起 HTTP 请求前抛出明确的 `UnsupportedContentError`，不得静默丢弃图片。

### 6.3 AssistantMessage

一个 Pi assistant message 转换为 SDK `ChatCompletionAssistantMessageParam`。reasoning 是兼容服务扩展，通过局部交叉类型表示：

```ts
type CompatibleAssistantMessageParam = ChatCompletionAssistantMessageParam &
	Partial<Record<ReasoningField, string>>;

const message: CompatibleAssistantMessageParam = {
	role: "assistant",
	content,
	tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
};
```

转换规则：

- 所有 `TextContent.text` 按 content block 顺序连接为 `content`。
- 没有文本但存在 tool calls 时，`content` 为 `null`。
- 每个 Pi `ToolCall` 转换为 `tool_calls[].type = "function"`。
- `ToolCall.arguments` 使用 `JSON.stringify()`，不得使用对象直接替代字符串。
- tool call 的 `id` 和 `name` 不能为空；为空时在发请求前失败。
- `ThinkingContent` 不拼入普通 `content`。

思考回放规则：

- response parser 把实际采用的 reasoning 字段名保存在 `ThinkingContent.thinkingSignature`。
- 当 signature 是 `reasoning_content`、`reasoning` 或 `reasoning_text` 时，把 thinking 文本回放到同名 assistant 字段。
- signature 缺失或不是受支持字段时，MVP 不回放该 thinking block。
- 一个 assistant message 有多个 thinking block 时，只允许回放 signature 相同的 block；不同 signature 属于协议错误。

这条规则保证 tool call 后的下一次 LLM 请求可以尽量保持同一 provider 的 reasoning 上下文，同时避免把内部思考伪装成用户可见答案。

### 6.4 ToolResultMessage

每个 Pi tool result 转换为：

```ts
{
	role: "tool",
	tool_call_id: message.toolCallId,
	content: joinedText,
}
```

规则：

- `toolCallId` 不能为空。
- 所有文本 block 用换行连接。
- 没有文本且没有图片时使用 `"(no tool output)"`。
- MVP 不支持 tool-result image；遇到图片时在 HTTP 请求前抛出 `UnsupportedContentError`。
- `details`、`usage`、`isError` 和 `addedToolNames` 不直接进入 Chat Completions message。

### 6.5 Tool 定义

Pi `Tool` 转换为：

```ts
{
	type: "function",
	function: {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	},
}
```

adapter 不执行 TypeBox schema 校验。LLM 输出的最终 tool arguments 由 adapter 保证是 JSON object；是否符合具体 tool schema 继续由 Agent Core 在执行前校验。

## 7. OpenAI SDK Transport

### 7.1 SDK 调用

adapter 通过 SDK 发起请求并同时获取 typed chunk stream 和原始 HTTP response 元数据：

```ts
const { data: upstream, response } = await client.chat.completions
	.create(payload, {
		signal: options.signal,
		maxRetries: 0,
	})
	.withResponse();

await options.onResponse?.({
	status: response.status,
	headers: Object.fromEntries(response.headers.entries()),
});

accumulator.start();

for await (const chunk of upstream) {
	options.signal.throwIfAborted();
	accumulator.accept(chunk);
}

accumulator.finish();
```

OpenAI SDK 负责：

- 构造 HTTP 请求和 Authorization。
- 解析 SSE frame、`data:` 和 `[DONE]`。
- 处理 UTF-8、CRLF 和网络 byte chunk 边界。
- 把每个 data event 解码为 `ChatCompletionChunk`。
- 把 HTTP 和传输失败转换为 SDK error。

Ailoha adapter 不读取 `Response.body`，不实现 `TextDecoder`，也不解析原始 SSE 字符串。

`fetch` 注入只用于测试、代理或宿主 transport 定制，并通过 `new OpenAI({ fetch })` 交给 SDK。

### 7.2 生命周期

成功路径：

```text
validate config/context
→ build payload
→ SDK chat.completions.create(...).withResponse()
→ onResponse
→ emit start
→ for await SDK ChatCompletionChunk
→ SDK iterator 正常结束
→ finalize blocks
→ emit done
→ settle result()
```

失败路径：

- 在 SDK 返回成功 HTTP response 和 chunk iterator 之前失败：只发送 terminal `error`，不发送 `start`。
- 已发送 `start` 后失败：保留已累积的 content，发送 terminal `error`。
- 每条流必须且只能发送一次 terminal `done` 或 `error`。
- terminal event 后忽略后续 push。
- `result()` 必须解析为 terminal event 中携带的同一个 `AssistantMessage` 对象。

HTTP 非 2xx、SSE 解码和网络错误由 OpenAI SDK 抛出。adapter 把 SDK error 归一化为安全的 `errorMessage`；只保留 status、error name、message 和 provider request ID 等非敏感字段，不复制完整 request headers 或 API key。

MVP 显式设置 `maxRetries: 0`，不启用 SDK 自动重试。streaming 请求在部分输出后重试会导致重复文本和重复 tool arguments；重试策略需要 request replay ID 和去重规则，应作为后续独立设计。

## 8. SDK 类型和兼容扩展

```ts
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";

export type ReasoningField = "reasoning_content" | "reasoning" | "reasoning_text";

export type CompatibleReasoningDelta = Partial<Record<ReasoningField, string | null>>;

export type CompatibleUsage = NonNullable<ChatCompletionChunk["usage"]> & {
	prompt_cache_hit_tokens?: number;
	cached_tokens?: number;
	prompt_tokens_details?: {
		cached_tokens?: number;
		cache_write_tokens?: number;
	};
};
```

标准 message、tool、choice、delta、usage 和 chunk 类型直接使用 SDK。reasoning 字段及部分兼容 provider 的 cache usage 字段不在标准 SDK 类型中，只通过上面的局部交叉类型读取：

```ts
const delta = choice.delta as typeof choice.delta & CompatibleReasoningDelta;
const usage = chunk.usage as CompatibleUsage | undefined;
```

不得复制一整套 OpenAI wire 类型，也不得使用 `any` 绕过 SDK 类型。未知字段忽略。

MVP 只消费 `choices[0]`：

- request 固定 `n: 1`。
- `choices` 为空但存在 `usage` 时是合法 usage-only chunk。
- 第一项 choice 的 `index` 为 `0` 时合法。
- 第一项 choice 的 `index` 不是 `0` 时属于协议错误。
- 返回多个 choices 时属于协议错误，不静默忽略额外结果。

## 9. Response Accumulator

### 9.1 状态机

```text
created
  ├─ setup failure → failed
  └─ start() → receiving

receiving
  ├─ accept(chunk) → receiving
  ├─ finish() → completed
  └─ fail(error) → failed

completed / failed
  └─ 所有后续调用都是 no-op 或 programmer error，不得产生第二个 terminal event
```

每次 adapter stream 创建一个独立 accumulator。accumulator 不得跨请求复用。

### 9.2 初始 AssistantMessage

```ts
const message: AssistantMessage = {
	role: "assistant",
	content: [],
	api: model.api,
	provider: model.provider,
	model: model.id,
	usage: emptyUsage(),
	stopReason: "pending",
	timestamp: Date.now(),
};
```

整个 streaming 生命周期只维护这一份 message。所有非 terminal 事件的 `partial` 指向这份实时增长的对象，不是 event-time snapshot。

### 9.3 Metadata 和 usage

每个 chunk 先处理与 choice 无关的字段：

- 第一个非空 `chunk.id` 写入 `message.responseId`。
- 当 `chunk.model` 非空且不同于请求模型时，第一个值写入 `message.responseModel`。
- `chunk.usage` 出现时覆盖当前 normalized usage。

usage 映射：

```ts
const prompt = usage.prompt_tokens ?? 0;
const cacheRead =
	usage.prompt_tokens_details?.cached_tokens ??
	usage.prompt_cache_hit_tokens ??
	usage.cached_tokens ??
	0;
const cacheWrite = usage.prompt_tokens_details?.cache_write_tokens ?? 0;
const input = Math.max(0, prompt - cacheRead - cacheWrite);
const output = usage.completion_tokens ?? 0;
```

生成：

```ts
{
	input,
	output,
	cacheRead,
	cacheWrite,
	reasoning: usage.completion_tokens_details?.reasoning_tokens,
	totalTokens: input + output + cacheRead + cacheWrite,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
}
```

adapter 不负责定价。成本计算属于 model catalog 或更高层 accounting service。

### 9.4 最终答案

第一个非空 `delta.content` 创建一个 Pi text block：

```ts
{
	type: "text",
	text: "",
}
```

创建后立刻发送 `text_start`。每个非空 delta：

```ts
textBlock.text += delta;
emit({ type: "text_delta", contentIndex, delta, partial: message });
```

MVP 每条 assistant message 最多创建一个 text block。后续所有 `delta.content` 都追加到同一 block，即使中间出现 thinking 或 tool-call delta。

### 9.5 思考过程

默认字段优先级：

```ts
["reasoning_content", "reasoning", "reasoning_text"]
```

可通过 `ChatCompletionsAdapterOptions.reasoningFields` 覆盖顺序或只启用部分字段。

规则：

1. 在第一个包含非空 reasoning delta 的 chunk 中，选择配置顺序中的第一个非空字段。
2. 锁定该字段，保存为 `activeReasoningField`。
3. 创建一个 Pi thinking block，并把字段名保存到 `thinkingSignature`。
4. 后续只读取该字段，忽略其他 reasoning 字段，防止兼容服务同时返回相同内容导致重复。
5. 每个非空增量发送 `thinking_delta`。

初始 block：

```ts
{
	type: "thinking",
	thinking: "",
	thinkingSignature: activeReasoningField,
}
```

如果 provider 不公开任何 configured reasoning 字段，adapter 不产生 thinking block。adapter 不尝试从普通答案文本、XML 标签或 Markdown 中猜测思考过程。

### 9.6 工具调用

“多个工具调用”表示同一个 assistant message 可以包含多个 `ToolCall`，不表示存在多条 SSE 连接，也不表示模型并行生成 token。

accumulator 按 upstream `tool_calls[].index` 保存独立状态：

```ts
interface ToolCallState {
	readonly upstreamIndex: number;
	readonly contentIndex: number;
	readonly block: ToolCall;
	argumentsJson: string;
}

const toolCallsByIndex = new Map<number, ToolCallState>();
```

第一次看到某个 index 时：

```ts
const block: ToolCall = {
	type: "toolCall",
	id: delta.id ?? "",
	name: delta.function?.name ?? "",
	arguments: {},
};
```

把 block 追加到 `message.content`，记录它的 `contentIndex`，发送 `toolcall_start`。

后续同 index delta：

- 第一个非空 `id` 写入 block。
- 第一个非空 function name 写入 block。
- 后续出现不同非空 id 或 name 时视为协议错误。
- `function.arguments` 原样追加到该 state 的 `argumentsJson`。
- 每个非空 arguments fragment 发送 `toolcall_delta`。

MVP streaming 期间保持 `block.arguments = {}`。原始增量通过 `toolcall_delta.delta` 向外发送；只在流结束时严格解析完整 JSON。MVP 不实现 partial JSON repair 或预览对象。

最终解析：

```ts
const parsed: unknown = JSON.parse(state.argumentsJson || "{}");
if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
	throw new ChatCompletionsProtocolError("Tool arguments must be a JSON object");
}
state.block.arguments = parsed as Record<string, unknown>;
```

最终必须同时满足：

- tool call id 非空。
- tool name 非空。
- arguments 是合法 JSON object。

adapter 只保证 JSON 结构，不校验具体 tool schema。Agent Core 保持现有的 TypeBox 校验责任。

### 9.7 思考过程进入 Context

adapter 不为思考过程创建独立 message。公开 reasoning 与最终答案、工具调用共同组成同一个 Pi `AssistantMessage`：

```ts
{
	role: "assistant",
	content: [
		{
			type: "thinking",
			thinking: "先查询天气，再结合行程回答。",
			thinkingSignature: "reasoning_content",
		},
		{
			type: "toolCall",
			id: "call_weather",
			name: "get_weather",
			arguments: { city: "上海" },
		},
	],
	api: model.api,
	provider: model.provider,
	model: model.id,
	stopReason: "toolUse",
	// usage、timestamp 等字段省略
}
```

正常完成后，现有 Agent Core 会把完整 assistant message 一次性追加到 run-local context 和 ContextManager history：

```text
SDK reasoning delta
→ ThinkingContent
→ final AssistantMessage.content
→ ModelRunner.run() resolve
→ ContextManager.append(context, assistant)
→ 下一轮 LLM context.messages
```

规则：

- streaming 期间的 partial message 不直接写入 ContextManager。
- 只有 adapter 成功返回的最终 `AssistantMessage` 才由 Agent 追加一次，避免每个 token 都修改 context history。
- thinking、tool calls 和 text 保持在同一 assistant message 内的 content block 顺序。
- adapter 不得把 thinking 合并进普通 `TextContent`。
- adapter 不得只保留 reasoning token 数量而丢弃 provider 已公开的 reasoning 文本。
- adapter 返回 `error` 或 `aborted` 时，现有 Agent 会在追加 assistant 前抛错，因此失败请求的 partial thinking 不进入对话 context。
- 如果未来需要保留失败请求的 partial thinking，应写入独立 transcript/trace，不得把未完成 assistant message 注入下一轮模型上下文。

ContextManager history 是后续模型调用使用的工作上下文，不是永久审计记录。compact 可以摘要或替换其中的 thinking block；需要永久保存原始思考过程时，必须由 adapter 外部的 transcript/trace sink 另行持久化。

### 9.8 下一轮请求的 Thinking 回放

“存进 context”和“重新发送给 provider”是两件事：

- 存储：完整 `ThinkingContent` 保存在 Pi assistant message 中。
- 回放：`request.ts` 决定是否把该 thinking block 转换成 provider 扩展字段。

MVP 只在以下条件全部满足时回放 thinking：

1. 历史 assistant message 的 `provider` 等于当前请求 `model.provider`。
2. 历史 assistant message 的 `model` 等于当前请求 `model.id`。
3. `thinkingSignature` 是当前 adapter 配置允许的 reasoning field。
4. thinking 文本非空。

例如：

```ts
if (
	message.provider === model.provider &&
	message.model === model.id &&
	isReasoningField(block.thinkingSignature) &&
	reasoningFields.includes(block.thinkingSignature)
) {
	assistantParam[block.thinkingSignature] = block.thinking;
}
```

跨 provider 或跨 model 时仍保留 context 中的 `ThinkingContent`，但不把它发送到新的 Chat Completions 请求。这样可以避免把一个 provider 的私有 reasoning 格式错误传给另一个 provider。

provider 不接受 reasoning 回放字段时，调用方应从 `reasoningFields` 中移除该字段；adapter 不自动把 thinking 降级成普通 assistant text。

### 9.9 Content block 顺序

`message.content` 按 block 第一次出现在响应流中的顺序排列。

例如先出现 reasoning，再出现两个 tool call，最后出现答案文本：

```text
content[0] ThinkingContent
content[1] ToolCall(index=0)
content[2] ToolCall(index=1)
content[3] TextContent
```

每个事件必须使用稳定的 `contentIndex`。block 创建后不得重新排序。

## 10. Finalization

### 10.1 何时结束

`finish_reason` 可能早于最后一个 usage-only chunk，因此看到 `finish_reason` 时只记录，不立即发送 `done`。

终止条件：

- OpenAI SDK 的 chunk async iterator 正常结束，并且已经收到非空 `finish_reason`；或
- SDK iterator 正常结束、未收到 `finish_reason`，但存在一个或多个完整 tool call，可以按兼容规则推断为 `toolUse`。

SDK iterator 正常结束、没有 `finish_reason` 且不存在 tool call 时属于协议错误。adapter 不直接观察或依赖原始 `[DONE]` frame。

### 10.2 Block end events

正常完成时，按 `message.content` 顺序 finalize：

- `TextContent` → `text_end`。
- `ThinkingContent` → `thinking_end`。
- `ToolCall` → 校验并解析 arguments，然后 `toolcall_end`。

异常或取消时不强制补发 block end 事件，直接发送 terminal `error`。消费者必须允许 `start → updates* → error`。

### 10.3 Stop reason

映射规则：

```text
stop / end                  → stop
length                      → length
tool_calls / function_call  → toolUse
content_filter              → error
network_error               → error
其他非空值                  → error
```

兼容规则：

- `finish_reason` 缺失但存在一个或多个完整 tool call 时，允许推断为 `toolUse`。
- `finish_reason` 缺失且没有 tool call 时，属于协议错误。
- `finish_reason` 是 `stop` 但存在 tool call 时，以内容事实为准，最终 `stopReason` 为 `toolUse`。
- `finish_reason` 是 `tool_calls` 但不存在 tool call 时，属于协议错误。

成功终止：

```ts
stream.push({
	type: "done",
	reason: message.stopReason,
	message,
});
```

`done.reason` 只能是 `stop`、`length` 或 `toolUse`。

## 11. Error 和取消

错误消息使用同一个部分 `AssistantMessage`：

```ts
message.stopReason = signal.aborted ? "aborted" : "error";
message.errorMessage = formatError(error);

stream.push({
	type: "error",
	reason: message.stopReason,
	error: message,
});
```

规则：

- `AbortSignal` 必须传给 `client.chat.completions.create()` 的 request options。
- 每次 SDK async iterator 产出 chunk 后、解析和发送事件前再次检查 signal。
- signal 已取消时，最终 reason 必须是 `aborted`，即使底层抛出普通网络错误。
- 取消后不得继续消费 SDK iterator、发送 delta 或发送 `done`。
- 已产生的 text、thinking 和 tool call partial state 保留在 error message 中。
- 临时 `argumentsJson` 不进入最终 Pi message，也不写入 errorMessage。
- API key、Authorization 和原始 headers 不得出现在错误文本。

错误类型：

```ts
export class ChatCompletionsConfigError extends Error {}
export class ChatCompletionsHttpError extends Error {
	readonly status: number;
}
export class ChatCompletionsProtocolError extends Error {}
export class UnsupportedContentError extends Error {}
```

构造参数错误和调用方传入的非法 Context 可以在 `stream()` 返回前同步抛出。SDK 请求、HTTP、SSE、JSON、provider protocol 和中途取消发生在异步 pump 中，必须通过 terminal `error` 事件结束。

## 12. Ailoha-owned Event Stream

为了不依赖 Pi adapter runtime，新 package 自己实现事件流，只复用 Pi 的事件类型。

```ts
class AssistantEventStreamImpl implements AssistantEventStream {
	push(event: AssistantMessageEvent): void;
	end(message: AssistantMessage): void;
	result(): Promise<AssistantMessage>;
	[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent>;
}
```

约束：

- FIFO。
- MVP 只保证一个 async iterator consumer。
- `result()` 不消费事件队列，可以与一个 iterator consumer 同时使用。
- 收到 `done` 或 `error` 时 settle `result()`。
- terminal event 本身仍必须交给 iterator consumer。
- terminal event 后 iterator 在交付完已排队事件后结束。
- `result()` 和 iterator 收到的 terminal message 必须是同一个对象引用。
- 没有 terminal event 不得只调用无结果的 `end()`；这属于实现错误。

## 13. 并发和所有权

一个 `ChatCompletionsAdapter` 实例可以被多个 Session 并发调用，但每次 `stream()` 必须创建自己的：

- event stream；
- accumulator；
- SDK chunk iterator；
- tool-call state map；
- abort-aware pump。

adapter 实例只保存不可变配置，不保存当前请求状态。

多个 tool call 只是在同一 assistant message 中具有多个独立 block。adapter 不执行工具，也不决定工具串行或并行执行。当前 Agent Core 保持按 assistant content 顺序串行执行。

## 14. 可观测性

MVP 支持两个无敏感数据的生命周期回调：

- `onPayload(payload)`：检查或替换发送前 payload。
- `onResponse({ status, headers })`：记录 HTTP response 元数据。

adapter 不直接依赖 Agent TraceRecorder。

后续如需 token-level Trace，composition root 可以消费 `AssistantEventStream` 并把事件转发到独立 sink；不得让 adapter 引用 Agent 或 Session 对象。

## 15. 测试要求

所有测试使用固定 `ChatCompletionChunk` fixture；adapter transport tests 通过 SDK 的 `fetch` 注入返回构造的 `Response` 和 `ReadableStream<Uint8Array>`，不请求真实 provider。

### 15.1 SDK transport tests

- SDK client 使用配置的 `baseURL`、API key、固定 `maxRetries: 0` 和 injected fetch。
- 请求 payload 包含 `stream: true` 和 `n: 1`。
- injected fetch 返回最小合法 SSE 后，adapter 收到 typed chunk 并产生 Pi events。
- SDK iterator 正常结束后 adapter 才 finalize。
- SDK HTTP error 在 start 前转换为 terminal error。
- SDK iterator error 在 start 后保留 partial content。
- 不重复测试 OpenAI SDK 已经覆盖的通用 SSE parser 行为。

### 15.2 Request conversion tests

- system + user text。
- assistant text replay。
- assistant tool calls replay。
- 多个 tool result replay。
- thinking 按 `thinkingSignature` 回放。
- 未知 thinking signature 不回放。
- 空 tool id/name 拒绝。
- user image 和 tool-result image 明确拒绝。
- tools 转换保留 name、description 和 parameters。
- 自定义 header 不能覆盖保留 headers。
- payload 不包含 `undefined` 字段。

### 15.3 Response accumulator tests

- 纯文本：`start → text_start → text_delta* → text_end → done`。
- reasoning + text：分别生成 thinking 和 text block。
- 同一 chunk 同时包含多个 reasoning 字段时只使用配置优先级最高的字段。
- reasoning 字段锁定后忽略其他 reasoning 字段。
- 单个工具调用的 arguments 被多个 chunk 拆分。
- 同一 assistant message 中有多个工具调用。
- 同一个 `ChatCompletionChunk` 的 `tool_calls` 数组包含多个 index。
- tool id/name 只在第一个 chunk 出现，后续只包含 arguments。
- 同 index 出现冲突 id/name 时失败。
- 工具 arguments 不是合法 JSON 时失败。
- 工具 arguments 是 array、null 或 primitive 时失败。
- usage-only final chunk 被处理。
- response ID 和 response model 被保留。
- content block index 在整个流中稳定。
- `finish_reason=stop/length/tool_calls/content_filter/unknown`。
- `finish_reason=stop` 但存在 tool call 时归一化为 `toolUse`。
- SDK iterator 结束前不提前 settle，确保最后 usage-only chunk 不丢失。

### 15.4 Error and cancellation tests

- SDK request/fetch reject before start。
- HTTP 401/429/500。
- SDK stream setup error。
- start 后 SDK iterator reject，partial content 保留。
- 请求前 signal 已取消。
- text delta 中途取消。
- tool arguments 中途取消。
- terminal event 恰好一次。
- 取消后不再发送 delta 或 done。
- 错误和 callback 中不泄漏 API key。

### 15.5 Agent integration tests

- adapter 返回纯文本，Agent 正常结束。
- adapter 返回 reasoning + text，完整 `ThinkingContent` 和 `TextContent` 被追加到 ContextManager history。
- adapter streaming 尚未结束时，ContextManager history 不包含 partial assistant message。
- 同 provider、同 model 的下一轮请求把 thinking 回放到 `thinkingSignature` 指定的 reasoning field。
- 跨 provider 或跨 model 的下一轮请求保留本地 thinking，但不向上游回放。
- adapter 失败或取消时，partial thinking 不进入后续模型 context。
- adapter 返回一个 tool call，Agent 执行工具并发起下一次 LLM 请求。
- adapter 返回多个 tool call，当前 Agent 按顺序执行并完整回放全部 tool results。
- tool arguments JSON 合法但 schema 不合法时，由 Agent 返回 tool error，不由 adapter 报 protocol error。
- adapter 返回 `error` 或 `aborted` message 时，现有 Agent 转换为相应失败。

## 16. 验收标准

实现完成必须满足：

1. production source 不导入 Pi Chat Completions adapter、compat 或 provider factory；OpenAI SDK 是唯一的 Chat Completions transport dependency。
2. Pi 消息和事件类型保持不变，现有 Agent 不需要理解 Chat Completion chunk。
3. 标准 Chat Completion wire-protocol 类型来自 OpenAI SDK；Pi message 转换、reasoning 扩展和 chunk 聚合逻辑只存在于新 adapter package。
4. text、公开 reasoning、单工具调用、多工具调用、usage、stop reason 和取消均有确定性测试。
5. stream 成功时事件序列合法且只产生一个 `done`。
6. stream 失败时保留 partial message 且只产生一个 `error`。
7. 工具参数在 `toolcall_end` 前完成严格 JSON object 校验。
8. 当前 `ModelRunner` 可以通过 `adapter.complete()` 无改动接入。
9. provider 公开的 reasoning 文本作为 `ThinkingContent` 随成功 assistant message 进入 ContextManager history。
10. thinking 只向同 provider、同 model 且支持对应 reasoning field 的请求回放。
11. `npm run check` 无 error、warning 或 info。
12. 只运行新 package 的定向测试以及受影响的 Agent integration tests，不调用真实 LLM API。

## 17. 明确不做

MVP 不实现：

- OpenAI Responses API。
- 非 streaming Chat Completions 路径。
- Pi provider/model registry。
- OAuth、环境变量自动发现或 credential store。
- 自动重试、退避和 rate-limit 策略。
- partial JSON repair。
- tool schema 校验或工具执行。
- 并行工具执行。
- 多 choice 或 `n > 1`。
- legacy `delta.function_call`。
- audio、logprobs、video。
- image input 或 image tool results。
- prompt cache、provider-specific reasoning effort 和各种 compat 自动探测。
- 从普通文本猜测隐藏 chain-of-thought。
- 把 streaming events 暴露到现有 Agent 公共接口。

这些能力只有在出现明确需求和独立测试契约后才能加入，不能通过条件分支逐步把 MVP 重新扩张成 Pi adapter 的复制品。

## 18. 实施顺序

```text
1. types.ts：公开 adapter 类型、reasoning/cache 兼容扩展
2. event-stream.ts：FIFO、iterator、terminal result
3. request.ts：Pi Context 到 SDK Chat Completions payload
4. response-accumulator.ts：SDK chunk 到 Pi blocks/events
5. adapter.ts：OpenAI client、chunk pump、取消和错误闭合
6. index.ts：稳定 exports
7. deterministic unit tests
8. ModelRunner integration test
9. 把 demo 从 completeSimple() 迁移到 adapter.complete()
```

前五步完成并通过单元测试前，不修改现有 demo 和 Agent Core。这样解析器可以在不影响当前运行路径的情况下独立验证。
