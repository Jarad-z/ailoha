import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	Tool,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionCreateParamsStreaming,
	ChatCompletionMessageParam,
	ChatCompletionMessageToolCall,
	ChatCompletionTool,
} from "openai/resources/chat/completions.js";
import { ChatCompletionsProtocolError, UnsupportedContentError } from "./errors.js";
import type { AdapterRequestConfig, ChatCompletionsRunOptions, ReasoningField } from "./types.js";
import { isReasoningField } from "./types.js";

type CompatibleAssistantMessageParam = ChatCompletionAssistantMessageParam &
	Partial<Record<ReasoningField, string>>;

function requireNonEmpty(value: string, label: string): string {
	if (value.trim().length === 0) throw new ChatCompletionsProtocolError(`${label} must not be empty.`);
	return value;
}

function convertUserMessage(message: Extract<Message, { role: "user" }>): ChatCompletionMessageParam {
	if (typeof message.content === "string") return { role: "user", content: message.content };
	const text: string[] = [];
	for (const block of message.content) {
		if (block.type === "image") throw new UnsupportedContentError("User image content is not supported.");
		text.push(block.text);
	}
	return { role: "user", content: text.join("\n") };
}

function convertToolCall(block: Extract<AssistantMessage["content"][number], { type: "toolCall" }>): ChatCompletionMessageToolCall {
	requireNonEmpty(block.id, "Tool call id");
	requireNonEmpty(block.name, "Tool call name");
	let argumentsJson: string;
	try {
		argumentsJson = JSON.stringify(block.arguments);
	} catch (cause) {
		throw new ChatCompletionsProtocolError("Tool call arguments are not JSON serializable.", { cause });
	}
	if (argumentsJson === undefined) {
		throw new ChatCompletionsProtocolError("Tool call arguments are not JSON serializable.");
	}
	return { type: "function", id: block.id, function: { name: block.name, arguments: argumentsJson } };
}

function convertAssistantMessage(
	message: AssistantMessage,
	model: Model<string>,
	reasoningFields: readonly ReasoningField[],
): CompatibleAssistantMessageParam {
	const text = message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
	const toolCalls = message.content.filter((block) => block.type === "toolCall").map(convertToolCall);
	const converted: CompatibleAssistantMessageParam = {
		role: "assistant",
		content: text.length === 0 && toolCalls.length > 0 ? null : text,
		...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
	};

	if (message.provider !== model.provider || message.model !== model.id) return converted;
	let replayField: ReasoningField | undefined;
	let replayText = "";
	for (const block of message.content) {
		if (block.type !== "thinking" || block.thinking.length === 0) continue;
		if (!isReasoningField(block.thinkingSignature) || !reasoningFields.includes(block.thinkingSignature)) continue;
		if (replayField && replayField !== block.thinkingSignature) {
			throw new ChatCompletionsProtocolError("Assistant thinking blocks use conflicting reasoning fields.");
		}
		replayField = block.thinkingSignature;
		replayText += block.thinking;
	}
	if (replayField) converted[replayField] = replayText;
	return converted;
}

function convertToolResult(message: ToolResultMessage): ChatCompletionMessageParam {
	requireNonEmpty(message.toolCallId, "Tool result toolCallId");
	const text: string[] = [];
	for (const block of message.content) {
		if (block.type === "image") throw new UnsupportedContentError("Tool-result image content is not supported.");
		text.push(block.text);
	}
	return {
		role: "tool",
		tool_call_id: message.toolCallId,
		content: text.length > 0 ? text.join("\n") : "(no tool output)",
	};
}

export function convertMessages(
	context: Context,
	model: Model<string>,
	reasoningFields: readonly ReasoningField[],
): ChatCompletionMessageParam[] {
	const messages: ChatCompletionMessageParam[] = [];
	if (context.systemPrompt && context.systemPrompt.length > 0) {
		messages.push({ role: "system", content: context.systemPrompt });
	}
	for (const message of context.messages) {
		if (message.role === "user") messages.push(convertUserMessage(message));
		else if (message.role === "assistant") messages.push(convertAssistantMessage(message, model, reasoningFields));
		else messages.push(convertToolResult(message));
	}
	return messages;
}

function convertTool(tool: Tool): ChatCompletionTool {
	requireNonEmpty(tool.name, "Tool name");
	return {
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters as Record<string, unknown>,
		},
	};
}

export function buildPayload(
	context: Context,
	config: AdapterRequestConfig,
	options: ChatCompletionsRunOptions,
): ChatCompletionCreateParamsStreaming {
	const messages = convertMessages(context, config.model, config.reasoningFields);
	const tools = (context.tools ?? []).map(convertTool);
	return {
		model: config.model.id,
		messages,
		stream: true,
		n: 1,
		...(config.includeUsage ? { stream_options: { include_usage: true } } : {}),
		...(tools.length > 0 ? { tools } : {}),
		...(options.toolChoice === undefined ? {} : { tool_choice: options.toolChoice }),
		...(options.temperature === undefined ? {} : { temperature: options.temperature }),
		...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
	};
}
