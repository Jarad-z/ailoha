import type {
	AssistantMessage,
	AssistantMessageEvent,
	TextContent,
	ThinkingContent,
	ToolCall,
	Usage,
} from "@earendil-works/pi-ai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { ChatCompletionsProtocolError } from "./errors.js";
import type { CompatibleReasoningDelta, CompatibleUsage, ReasoningField } from "./types.js";

interface EventTarget {
	push(event: AssistantMessageEvent): void;
}

interface ToolCallState {
	readonly upstreamIndex: number;
	readonly contentIndex: number;
	readonly block: ToolCall;
	argumentsJson: string;
}

type AccumulatorState = "created" | "receiving" | "completed" | "failed";

export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function normalizeUsage(usage: CompatibleUsage): Usage {
	const prompt = usage.prompt_tokens ?? 0;
	const cacheRead =
		usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens ?? 0;
	const cacheWrite = usage.prompt_tokens_details?.cache_write_tokens ?? 0;
	const input = Math.max(0, prompt - cacheRead - cacheWrite);
	const output = usage.completion_tokens ?? 0;
	const reasoning = usage.completion_tokens_details?.reasoning_tokens;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		...(reasoning === undefined ? {} : { reasoning }),
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export class ResponseAccumulator {
	readonly message: AssistantMessage;
	readonly #events: EventTarget;
	readonly #reasoningFields: readonly ReasoningField[];
	readonly #toolCallsByIndex = new Map<number, ToolCallState>();
	#state: AccumulatorState = "created";
	#text?: { readonly block: TextContent; readonly contentIndex: number };
	#thinking?: { readonly block: ThinkingContent; readonly contentIndex: number };
	#activeReasoningField?: ReasoningField;
	#finishReason?: string;

	constructor(
		model: { readonly api: string; readonly provider: string; readonly id: string },
		reasoningFields: readonly ReasoningField[],
		events: EventTarget,
	) {
		this.#events = events;
		this.#reasoningFields = reasoningFields;
		this.message = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "pending",
			timestamp: Date.now(),
		};
	}

	get state(): AccumulatorState {
		return this.#state;
	}

	start(): void {
		if (this.#state !== "created") throw new Error(`Cannot start accumulator in ${this.#state} state.`);
		this.#state = "receiving";
		this.#events.push({ type: "start", partial: this.message });
	}

	accept(chunk: ChatCompletionChunk): void {
		if (this.#state !== "receiving") throw new Error(`Cannot accept chunk in ${this.#state} state.`);
		if (chunk.id && !this.message.responseId) this.message.responseId = chunk.id;
		if (chunk.model && chunk.model !== this.message.model && !this.message.responseModel) {
			this.message.responseModel = chunk.model;
		}
		if (chunk.usage) this.message.usage = normalizeUsage(chunk.usage as CompatibleUsage);
		if (chunk.choices.length === 0) return;
		if (chunk.choices.length !== 1) throw new ChatCompletionsProtocolError("Expected exactly one Chat Completions choice.");
		const choice = chunk.choices[0];
		if (choice.index !== 0) throw new ChatCompletionsProtocolError(`Expected choice index 0, received ${choice.index}.`);
		if (choice.finish_reason) {
			const received = String(choice.finish_reason);
			if (this.#finishReason && this.#finishReason !== received) {
				throw new ChatCompletionsProtocolError("Conflicting finish_reason values received.");
			}
			this.#finishReason = received;
		}
		const delta = choice.delta as typeof choice.delta & CompatibleReasoningDelta;
		this.#acceptReasoning(delta);
		if (delta.content) this.#acceptText(delta.content);
		for (const toolDelta of delta.tool_calls ?? []) {
			const state = this.#toolCall(toolDelta.index, toolDelta.id, toolDelta.function?.name);
			const fragment = toolDelta.function?.arguments;
			if (fragment) {
				state.argumentsJson += fragment;
				this.#events.push({
					type: "toolcall_delta",
					contentIndex: state.contentIndex,
					delta: fragment,
					partial: this.message,
				});
			}
		}
	}

	finish(): void {
		if (this.#state !== "receiving") return;
		const toolStates = [...this.#toolCallsByIndex.values()];
		if (!this.#finishReason && toolStates.length === 0) {
			throw new ChatCompletionsProtocolError("Stream ended without finish_reason or tool calls.");
		}
		if (this.#finishReason === "tool_calls" || this.#finishReason === "function_call") {
			if (toolStates.length === 0) {
				throw new ChatCompletionsProtocolError("finish_reason indicates tool use but no tool call was received.");
			}
		}
		const stopReason = this.#normalizeStopReason(this.#finishReason, toolStates.length > 0);
		const parsedArguments = toolStates.map((state) => this.#parseToolArguments(state));
		for (let index = 0; index < toolStates.length; index++) toolStates[index].block.arguments = parsedArguments[index];
		this.message.stopReason = stopReason;
		if (this.#finishReason) this.message.rawStopReason = this.#finishReason;
		for (let contentIndex = 0; contentIndex < this.message.content.length; contentIndex++) {
			const block = this.message.content[contentIndex];
			if (block.type === "text") {
				this.#events.push({ type: "text_end", contentIndex, content: block.text, partial: this.message });
			} else if (block.type === "thinking") {
				this.#events.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: this.message });
			} else {
				this.#events.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: this.message });
			}
		}
		this.#state = "completed";
		this.#events.push({ type: "done", reason: stopReason, message: this.message });
	}

	fail(error: unknown, aborted: boolean, errorMessage: string): void {
		if (this.#state === "completed" || this.#state === "failed") return;
		this.#state = "failed";
		this.message.stopReason = aborted ? "aborted" : "error";
		this.message.errorMessage = errorMessage;
		const candidate = error as {
			readonly name?: unknown;
			readonly code?: unknown;
			readonly status?: unknown;
			readonly type?: unknown;
		};
		const providerCode = typeof candidate?.code === "string" ? candidate.code : undefined;
		const normalizedCode =
			providerCode === "context_length_exceeded" ||
			providerCode === "context_window_exceeded" ||
			providerCode === "max_context_length_exceeded"
				? "CONTEXT_WINDOW_EXCEEDED"
				: undefined;
		this.message.diagnostics = [...(this.message.diagnostics ?? []), {
			type: "chat_completions_failure",
			timestamp: Date.now(),
			error: {
				name: typeof candidate?.name === "string" ? candidate.name : "Error",
				message: errorMessage,
				...(normalizedCode ? { code: normalizedCode } : providerCode ? { code: providerCode } : {}),
			},
			details: {
				...(typeof candidate?.status === "number" ? { status: candidate.status } : {}),
				...(providerCode ? { providerCode } : {}),
				...(typeof candidate?.type === "string" ? { providerType: candidate.type } : {}),
				...(normalizedCode ? { code: normalizedCode } : {}),
			},
		}];
		this.#events.push({ type: "error", reason: this.message.stopReason, error: this.message });
	}

	#acceptReasoning(delta: CompatibleReasoningDelta): void {
		if (!this.#activeReasoningField) {
			this.#activeReasoningField = this.#reasoningFields.find((field) => Boolean(delta[field]));
		}
		if (!this.#activeReasoningField) return;
		const fragment = delta[this.#activeReasoningField];
		if (!fragment) return;
		if (!this.#thinking) {
			const block: ThinkingContent = {
				type: "thinking",
				thinking: "",
				thinkingSignature: this.#activeReasoningField,
			};
			const contentIndex = this.message.content.push(block) - 1;
			this.#thinking = { block, contentIndex };
			this.#events.push({ type: "thinking_start", contentIndex, partial: this.message });
		}
		this.#thinking.block.thinking += fragment;
		this.#events.push({
			type: "thinking_delta",
			contentIndex: this.#thinking.contentIndex,
			delta: fragment,
			partial: this.message,
		});
	}

	#acceptText(fragment: string): void {
		if (!this.#text) {
			const block: TextContent = { type: "text", text: "" };
			const contentIndex = this.message.content.push(block) - 1;
			this.#text = { block, contentIndex };
			this.#events.push({ type: "text_start", contentIndex, partial: this.message });
		}
		this.#text.block.text += fragment;
		this.#events.push({ type: "text_delta", contentIndex: this.#text.contentIndex, delta: fragment, partial: this.message });
	}

	#toolCall(index: number, id: string | undefined, name: string | undefined): ToolCallState {
		let state = this.#toolCallsByIndex.get(index);
		if (!state) {
			const block: ToolCall = { type: "toolCall", id: id ?? "", name: name ?? "", arguments: {} };
			const contentIndex = this.message.content.push(block) - 1;
			state = { upstreamIndex: index, contentIndex, block, argumentsJson: "" };
			this.#toolCallsByIndex.set(index, state);
			this.#events.push({ type: "toolcall_start", contentIndex, partial: this.message });
		}
		if (id) {
			if (state.block.id && state.block.id !== id) throw new ChatCompletionsProtocolError(`Conflicting tool call id at index ${index}.`);
			state.block.id ||= id;
		}
		if (name) {
			if (state.block.name && state.block.name !== name) {
				throw new ChatCompletionsProtocolError(`Conflicting tool call name at index ${index}.`);
			}
			state.block.name ||= name;
		}
		return state;
	}

	#parseToolArguments(state: ToolCallState): Record<string, unknown> {
		if (state.block.id.trim().length === 0) throw new ChatCompletionsProtocolError(`Tool call ${state.upstreamIndex} has no id.`);
		if (state.block.name.trim().length === 0) throw new ChatCompletionsProtocolError(`Tool call ${state.upstreamIndex} has no name.`);
		let parsed: unknown;
		try {
			parsed = JSON.parse(state.argumentsJson || "{}");
		} catch (cause) {
			throw new ChatCompletionsProtocolError(`Tool call ${state.upstreamIndex} arguments are invalid JSON.`, { cause });
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new ChatCompletionsProtocolError("Tool arguments must be a JSON object.");
		}
		return parsed as Record<string, unknown>;
	}

	#normalizeStopReason(finishReason: string | undefined, hasToolCalls: boolean): "stop" | "length" | "toolUse" {
		if (!finishReason && hasToolCalls) return "toolUse";
		if ((finishReason === "stop" || finishReason === "end") && hasToolCalls) return "toolUse";
		if (finishReason === "stop" || finishReason === "end") return "stop";
		if (finishReason === "length") return "length";
		if (finishReason === "tool_calls" || finishReason === "function_call") return "toolUse";
		if (finishReason === "content_filter") {
			throw new ChatCompletionsProtocolError("Provider stopped generation because of content filtering.");
		}
		throw new ChatCompletionsProtocolError(`Unsupported finish_reason: ${finishReason ?? "missing"}.`);
	}
}
