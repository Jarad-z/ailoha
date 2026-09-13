import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	ProviderHeaders,
} from "@earendil-works/pi-ai";
import type {
	ChatCompletionChunk,
	ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions.js";

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

export interface ChatCompletionsAdapterOptions {
	readonly model: Model<Api>;
	readonly apiKey: string;
	readonly headers?: ProviderHeaders;
	readonly fetch?: typeof globalThis.fetch;
	readonly timeoutMs?: number;
	readonly includeUsage?: boolean;
	readonly reasoningFields?: readonly ReasoningField[];
	readonly retry?: false | Partial<RetryPolicy>;
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
	readonly onRetry?: (event: RetryEvent) => void | Promise<void>;
}

export interface RetryPolicy {
	readonly maxAttempts: number;
	readonly baseDelayMs: number;
	readonly maxDelayMs: number;
	readonly respectRetryAfter: boolean;
}

export interface RetryEvent {
	readonly attempt: number;
	readonly nextAttempt: number;
	readonly delayMs: number;
	readonly reason: "timeout" | "connection" | "http_status";
	readonly status?: number;
	readonly requestId?: string;
}

export interface AssistantEventStream extends AsyncIterable<AssistantMessageEvent> {
	result(): Promise<AssistantMessage>;
}

export interface AdapterRequestConfig {
	readonly model: Model<Api>;
	readonly includeUsage: boolean;
	readonly reasoningFields: readonly ReasoningField[];
}

export const DEFAULT_REASONING_FIELDS: readonly ReasoningField[] = Object.freeze([
	"reasoning_content",
	"reasoning",
	"reasoning_text",
]);

export function isReasoningField(value: string | undefined): value is ReasoningField {
	return value === "reasoning_content" || value === "reasoning" || value === "reasoning_text";
}

export type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, ProviderHeaders };
