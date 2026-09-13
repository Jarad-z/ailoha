# 使用 OpenAI SDK 直接调用 Chat Completions

本文说明如何在 Node.js 22+ 中使用官方 OpenAI Node SDK 调用 Chat Completions，不经过 Pi adapter。

OpenAI-compatible 服务也可以使用同一个 SDK，只需要替换 `baseURL`、API key 和模型名。SDK 负责 HTTP 请求、响应 JSON 和 SSE 解码；调用方仍需自行处理 reasoning 扩展字段、流式工具参数聚合，以及到 Pi `AssistantMessage` 的转换。

本文示例基于仓库当前可用的 `openai@6.40.0`。

## 1. 安装 SDK

实际使用 SDK 的 workspace package 必须把 `openai` 声明为直接依赖，不能依赖 Pi 间接安装的副本：

```bash
npm install openai@6.40.0 --workspace=@ailoha/chat-completions-adapter
```

如果只是编写仓库根目录下的临时脚本：

```bash
npm install openai@6.40.0
```

## 2. 环境配置

```dotenv
CHAT_COMPLETIONS_BASE_URL=https://api.openai.com/v1
CHAT_COMPLETIONS_API_KEY=replace-me
CHAT_COMPLETIONS_MODEL=replace-with-model-id
```

如果兼容服务给出的完整请求地址是：

```text
https://example.com/v1/chat/completions
```

那么 SDK 的 `baseURL` 应该是：

```text
https://example.com/v1
```

不要把 `/chat/completions` 放进 `baseURL`，SDK 会自动追加该路径。

## 3. 创建客户端

```ts
import OpenAI from "openai";

const baseURL = process.env.CHAT_COMPLETIONS_BASE_URL;
const apiKey = process.env.CHAT_COMPLETIONS_API_KEY;
const model = process.env.CHAT_COMPLETIONS_MODEL;

if (!baseURL) throw new Error("CHAT_COMPLETIONS_BASE_URL is missing");
if (!apiKey) throw new Error("CHAT_COMPLETIONS_API_KEY is missing");
if (!model) throw new Error("CHAT_COMPLETIONS_MODEL is missing");

const client = new OpenAI({
	apiKey,
	baseURL,
	timeout: 60_000,
	maxRetries: 0,
});
```

这里显式设置 `maxRetries: 0`。非流式请求可以按业务需要重试，但流式请求一旦输出部分内容，自动重试可能造成重复文本或重复工具参数，应由更高层制定去重策略。

API key 和 Authorization header 不得写入日志、Trace 或错误快照。

## 4. 非流式调用

```ts
const completion = await client.chat.completions.create({
	model,
	stream: false,
	messages: [
		{
			role: "system",
			content: "You are a concise assistant.",
		},
		{
			role: "user",
			content: "用一句话解释事件循环。",
		},
	],
});

const choice = completion.choices[0];

if (!choice) {
	throw new Error("Chat Completions response contains no choice");
}

console.log("response id:", completion.id);
console.log("response model:", completion.model);
console.log("finish reason:", choice.finish_reason);
console.log("answer:", choice.message.content ?? "");
console.log("tool calls:", choice.message.tool_calls ?? []);
console.log("usage:", completion.usage ?? null);
```

运行 TypeScript 示例时，可以把代码放进项目现有的编译流程。使用 `.mjs` 时删除类型声明即可：

```bash
node --env-file=.env.local script.mjs
```

## 5. 流式调用

SDK 会把 SSE 解码为 `AsyncIterable<ChatCompletionChunk>`。调用方不需要自己操作 `ReadableStream`、`TextDecoder` 或 `data:` 行。

```ts
import type { CompletionUsage } from "openai/resources/completions.js";

const stream = await client.chat.completions.create(
	{
		model,
		stream: true,
		stream_options: {
			include_usage: true,
		},
		messages: [
			{
				role: "user",
				content: "解释一下事件循环。",
			},
		],
	},
	{
		signal: AbortSignal.timeout(60_000),
	},
);

let answer = "";
let finishReason: string | null = null;
let usage: CompletionUsage | null | undefined;

for await (const chunk of stream) {
	if (chunk.usage) {
		usage = chunk.usage;
	}

	const choice = chunk.choices[0];
	if (!choice) continue;

	if (choice.delta.content) {
		answer += choice.delta.content;
		process.stdout.write(choice.delta.content);
	}

	if (choice.finish_reason) {
		finishReason = choice.finish_reason;
	}
}

process.stdout.write("\n");
console.log("finish reason:", finishReason);
console.log("usage:", usage ?? null);
console.log("full answer:", answer);
```

`finish_reason` 可能早于最后一个 usage-only chunk。不要在首次看到 `finish_reason` 时 `break`；继续迭代到 SDK stream 自然结束，才能保留最终 usage。

## 6. 同时获取原始 HTTP response

需要读取 status 或 response headers 时使用 SDK 的 `withResponse()`：

```ts
const { data: stream, response } = await client.chat.completions
	.create(
		{
			model,
			stream: true,
			stream_options: {
				include_usage: true,
			},
			messages: [
				{
					role: "user",
					content: "你好",
				},
			],
		},
		{
			signal: AbortSignal.timeout(60_000),
		},
	)
	.withResponse();

console.log("status:", response.status);
console.log("request id:", response.headers.get("x-request-id"));

for await (const chunk of stream) {
	// consume chunk
}
```

这也是当前 Pi Chat Completions 实现采用的 SDK 调用形式，但新的 Ailoha adapter 只复用这种 SDK 能力，不调用 Pi 的 adapter。

## 7. 提取公开的思考过程

标准 SDK 的 `ChatCompletionChunk` 类型不保证包含 provider 扩展的 reasoning 字段。一些 OpenAI-compatible 服务会在 delta 中返回：

```text
reasoning_content
reasoning
reasoning_text
```

可以在 SDK 类型上增加一个本地扩展：

```ts
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";

type ReasoningField =
	| "reasoning_content"
	| "reasoning"
	| "reasoning_text";

type ChatCompletionDelta = ChatCompletionChunk["choices"][number]["delta"];

type ReasoningDelta = ChatCompletionDelta &
	Partial<Record<ReasoningField, string | null>>;

const reasoningFields: readonly ReasoningField[] = [
	"reasoning_content",
	"reasoning",
	"reasoning_text",
];
```

正式实现应在首次收到 reasoning 时锁定一个字段，避免兼容服务同时返回两个相同字段造成重复：

```ts
let activeReasoningField: ReasoningField | undefined;
let thinking = "";

function readReasoning(chunk: ChatCompletionChunk): string | undefined {
	const choice = chunk.choices[0];
	if (!choice) return undefined;

	const delta = choice.delta as ReasoningDelta;

	if (activeReasoningField) {
		const value = delta[activeReasoningField];
		return typeof value === "string" && value.length > 0
			? value
			: undefined;
	}

	for (const field of reasoningFields) {
		const value = delta[field];
		if (typeof value === "string" && value.length > 0) {
			activeReasoningField = field;
			return value;
		}
	}

	return undefined;
}

for await (const chunk of stream) {
	const delta = readReasoning(chunk);
	if (!delta) continue;

	thinking += delta;
	process.stderr.write(delta);
}
```

如果 provider 不返回这些字段，就无法从普通 `content` 中可靠地区分隐藏思考和最终答案。不要从 XML、Markdown 或自然语言中猜测 chain-of-thought。

## 8. 声明工具

```ts
import type { ChatCompletionTool } from "openai/resources/chat/completions.js";

const tools: ChatCompletionTool[] = [
	{
		type: "function",
		function: {
			name: "get_weather",
			description: "查询指定城市的天气",
			parameters: {
				type: "object",
				properties: {
					city: {
						type: "string",
						description: "城市名称",
					},
				},
				required: ["city"],
				additionalProperties: false,
			},
		},
	},
];

const completion = await client.chat.completions.create({
	model,
	stream: false,
	messages: [
		{
			role: "user",
			content: "上海天气怎么样？",
		},
	],
	tools,
	tool_choice: "auto",
});
```

模型决定调用工具时：

```ts
const choice = completion.choices[0];
if (!choice) throw new Error("Response contains no choice");

for (const call of choice.message.tool_calls ?? []) {
	if (call.type !== "function") continue;

	const parsed: unknown = JSON.parse(call.function.arguments);

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Arguments for ${call.function.name} must be a JSON object`);
	}

	console.log(call.id, call.function.name, parsed);
}
```

SDK 会提供响应类型，但 `function.arguments` 仍然是 JSON 字符串。JSON 解析成功后还需要使用本地 JSON Schema 校验，不能直接执行工具。

## 9. 流式工具调用

流式工具调用通过 `choice.delta.tool_calls` 输出。工具参数可能被拆成多个字符串片段，需要按 `toolCall.index` 累加。

```ts
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";

interface ToolCallState {
	id: string;
	name: string;
	argumentsJson: string;
}

const toolCalls = new Map<number, ToolCallState>();

function acceptToolCalls(chunk: ChatCompletionChunk): void {
	const choice = chunk.choices[0];
	if (!choice) return;

	for (const delta of choice.delta.tool_calls ?? []) {
		let state = toolCalls.get(delta.index);

		if (!state) {
			state = {
				id: delta.id ?? "",
				name: delta.function?.name ?? "",
				argumentsJson: "",
			};
			toolCalls.set(delta.index, state);
		}

		if (delta.id) {
			if (state.id && state.id !== delta.id) {
				throw new Error(`Conflicting tool-call id at index ${delta.index}`);
			}
			state.id ||= delta.id;
		}

		if (delta.function?.name) {
			if (state.name && state.name !== delta.function.name) {
				throw new Error(`Conflicting tool name at index ${delta.index}`);
			}
			state.name ||= delta.function.name;
		}

		state.argumentsJson += delta.function?.arguments ?? "";
	}
}
```

在 SDK stream 自然结束后统一完成严格解析：

```ts
function finishToolCalls(): Array<{
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}> {
	return [...toolCalls.entries()]
		.sort(([left], [right]) => left - right)
		.map(([index, state]) => {
			if (!state.id) throw new Error(`Tool call ${index} has no id`);
			if (!state.name) throw new Error(`Tool call ${index} has no name`);

			const parsed: unknown = JSON.parse(state.argumentsJson || "{}");
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				throw new Error(`Arguments for ${state.name} must be a JSON object`);
			}

			return {
				id: state.id,
				name: state.name,
				arguments: parsed as Record<string, unknown>,
			};
		});
}
```

多个 tool call 仍然共用同一个串行 SDK stream。`index` 用来关联每个调用的 id、name 和参数片段，不表示模型同时生成多个 token 流。

## 10. 完整流式消费示例

下面的示例同时收集思考、最终答案、工具调用、usage 和停止原因：

```ts
import OpenAI from "openai";
import type {
	ChatCompletionChunk,
	ChatCompletionTool,
} from "openai/resources/chat/completions.js";
import type { CompletionUsage } from "openai/resources/completions.js";

type ReasoningField =
	| "reasoning_content"
	| "reasoning"
	| "reasoning_text";

type ChatCompletionDelta = ChatCompletionChunk["choices"][number]["delta"];
type ReasoningDelta = ChatCompletionDelta &
	Partial<Record<ReasoningField, string | null>>;

interface ToolCallState {
	id: string;
	name: string;
	argumentsJson: string;
}

const tools: ChatCompletionTool[] = [
	{
		type: "function",
		function: {
			name: "get_weather",
			description: "查询指定城市的天气",
			parameters: {
				type: "object",
				properties: {
					city: { type: "string" },
				},
				required: ["city"],
				additionalProperties: false,
			},
		},
	},
];

const apiKey = process.env.CHAT_COMPLETIONS_API_KEY;
const baseURL = process.env.CHAT_COMPLETIONS_BASE_URL;
const model = process.env.CHAT_COMPLETIONS_MODEL;

if (!apiKey || !baseURL || !model) {
	throw new Error("Chat Completions configuration is incomplete");
}

const client = new OpenAI({
	apiKey,
	baseURL,
	maxRetries: 0,
});

const signal = AbortSignal.timeout(60_000);
const stream = await client.chat.completions.create(
	{
		model,
		stream: true,
		stream_options: {
			include_usage: true,
		},
		messages: [
			{
				role: "user",
				content: "查询上海天气并给出建议。",
			},
		],
		tools,
		tool_choice: "auto",
	},
	{ signal },
);

const reasoningFields: readonly ReasoningField[] = [
	"reasoning_content",
	"reasoning",
	"reasoning_text",
];

let activeReasoningField: ReasoningField | undefined;
let thinking = "";
let answer = "";
let finishReason: string | null = null;
let usage: CompletionUsage | null | undefined;
const toolCallStates = new Map<number, ToolCallState>();

for await (const chunk of stream) {
	usage = chunk.usage ?? usage;

	const choice = chunk.choices[0];
	if (!choice) continue;

	const delta = choice.delta as ReasoningDelta;

	if (delta.content) {
		answer += delta.content;
		process.stdout.write(delta.content);
	}

	if (!activeReasoningField) {
		activeReasoningField = reasoningFields.find((field) => {
			const value = delta[field];
			return typeof value === "string" && value.length > 0;
		});
	}

	if (activeReasoningField) {
		const reasoningDelta = delta[activeReasoningField];
		if (typeof reasoningDelta === "string" && reasoningDelta.length > 0) {
			thinking += reasoningDelta;
		}
	}

	for (const toolDelta of delta.tool_calls ?? []) {
		let state = toolCallStates.get(toolDelta.index);
		if (!state) {
			state = {
				id: toolDelta.id ?? "",
				name: toolDelta.function?.name ?? "",
				argumentsJson: "",
			};
			toolCallStates.set(toolDelta.index, state);
		}

		state.id ||= toolDelta.id ?? "";
		state.name ||= toolDelta.function?.name ?? "";
		state.argumentsJson += toolDelta.function?.arguments ?? "";
	}

	if (choice.finish_reason) {
		finishReason = choice.finish_reason;
	}
}

const completedToolCalls = [...toolCallStates.entries()]
	.sort(([left], [right]) => left - right)
	.map(([index, state]) => {
		if (!state.id) throw new Error(`Tool call ${index} has no id`);
		if (!state.name) throw new Error(`Tool call ${index} has no name`);

		const parsed: unknown = JSON.parse(state.argumentsJson || "{}");
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error(`Arguments for ${state.name} must be a JSON object`);
		}

		return {
			id: state.id,
			name: state.name,
			arguments: parsed as Record<string, unknown>,
		};
	});

console.log({
	thinking,
	answer,
	toolCalls: completedToolCalls,
	finishReason,
	usage,
});
```

## 11. 把工具结果交还模型

模型返回工具调用后，下一轮必须包含：

1. 原始 user message。
2. 原始 assistant tool-call message。
3. 每个工具对应的 `role: "tool"` message。

非流式例子：

```ts
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

const first = await client.chat.completions.create({
	model,
	messages: [
		{
			role: "user",
			content: "上海天气怎么样？",
		},
	],
	tools,
});

const assistant = first.choices[0]?.message;
if (!assistant) throw new Error("Response contains no assistant message");

const messages: ChatCompletionMessageParam[] = [
	{
		role: "user",
		content: "上海天气怎么样？",
	},
	assistant,
];

for (const call of assistant.tool_calls ?? []) {
	if (call.type !== "function") continue;

	// 这里执行本地工具；示例使用固定结果。
	const toolResult = {
		temperature: 26,
		condition: "sunny",
	};

	messages.push({
		role: "tool",
		tool_call_id: call.id,
		content: JSON.stringify(toolResult),
	});
}

const second = await client.chat.completions.create({
	model,
	messages,
	tools,
});

console.log(second.choices[0]?.message.content ?? "");
```

不能只发送 tool result 而丢掉 assistant tool-call message，否则 provider 无法关联 `tool_call_id`。

## 12. 取消请求

SDK 的第二个参数接受 `signal`：

```ts
const controller = new AbortController();

const stream = await client.chat.completions.create(
	{
		model,
		stream: true,
		messages: [
			{
				role: "user",
				content: "写一篇长文。",
			},
		],
	},
	{
		signal: controller.signal,
	},
);

setTimeout(() => {
	controller.abort(new Error("Request timed out"));
}, 30_000);

try {
	for await (const chunk of stream) {
		controller.signal.throwIfAborted();
		process.stdout.write(chunk.choices[0]?.delta.content ?? "");
	}
} catch (error) {
	if (controller.signal.aborted) {
		console.error("request aborted");
	} else {
		throw error;
	}
}
```

## 13. SDK 错误处理

```ts
try {
	await client.chat.completions.create({
		model,
		messages: [
			{
				role: "user",
				content: "你好",
			},
		],
	});
} catch (error) {
	if (error instanceof OpenAI.APIError) {
		console.error({
			status: error.status,
			name: error.name,
			message: error.message,
			requestId: error.requestID,
		});
	} else {
		throw error;
	}
}
```

不得把 client 对象、request headers 或 API key 放进错误日志。

## 14. SDK 负责什么，adapter 负责什么

OpenAI SDK 负责：

- 构造 `/chat/completions` HTTP 请求。
- Authorization header。
- 请求 JSON 序列化。
- SSE 网络读取和解帧。
- `ChatCompletionChunk` 类型。
- HTTP/API error 对象。
- `AbortSignal` 接入。

Ailoha adapter 仍然负责：

- Pi `Context` 到 `ChatCompletionMessageParam[]`。
- provider reasoning 扩展字段提取。
- 文本和 thinking block 累加。
- 流式 tool-call arguments 聚合。
- tool arguments 最终 JSON object 校验。
- usage 归一化。
- `finish_reason` 到 Pi `StopReason`。
- Pi `AssistantMessageEvent` 的 start/delta/end/done/error 顺序。
- 最终 Pi `AssistantMessage`。

完整路径：

```text
Pi Context
→ ChatCompletionMessageParam[]
→ OpenAI SDK chat.completions.create({ stream: true })
→ AsyncIterable<ChatCompletionChunk>
→ Ailoha response accumulator
→ Pi AssistantMessageEvent
→ Pi AssistantMessage
```

正式 adapter 的完整设计和验收规则见 [Minimal OpenAI Chat Completions Adapter Spec](./chat-completions-adapter-spec.md)。该 spec 中关于 raw `fetch` 和自行实现 SSE 的部分，应在实现前同步调整为 OpenAI SDK transport。
