import OpenAI from "openai";
import type { Context } from "@earendil-works/pi-ai";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions.js";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { ChatCompletionsConfigError } from "./errors.js";
import { AssistantEventStreamImpl } from "./event-stream.js";
import { buildPayload } from "./request.js";
import { ResponseAccumulator } from "./response-accumulator.js";
import { abortableSleep, decideRetry, normalizeRetryPolicy } from "./retry.js";
import type {
	AdapterRequestConfig,
	AssistantEventStream,
	ChatCompletionsAdapterOptions,
	ChatCompletionsRunOptions,
	ReasoningField,
} from "./types.js";
import { DEFAULT_REASONING_FIELDS } from "./types.js";

const RESERVED_HEADERS = new Set(["authorization", "accept", "content-type"]);

function requireConfigValue(value: string, label: string): void {
	if (value.trim().length === 0) throw new ChatCompletionsConfigError(`${label} must not be empty.`);
}

function normalizeHeaders(headers: ChatCompletionsAdapterOptions["headers"]): Record<string, string> | undefined {
	if (!headers) return undefined;
	const normalized: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value === null) continue;
		if (RESERVED_HEADERS.has(name.toLowerCase())) {
			throw new ChatCompletionsConfigError(`Custom header ${name} cannot override an SDK-managed header.`);
		}
		normalized[name] = value;
	}
	return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function validateReasoningFields(fields: readonly ReasoningField[]): readonly ReasoningField[] {
	if (new Set(fields).size !== fields.length) {
		throw new ChatCompletionsConfigError("reasoningFields must not contain duplicates.");
	}
	return Object.freeze([...fields]);
}

export function formatAdapterError(error: unknown, apiKey: string): string {
	const candidate = error instanceof Error ? error : new Error(String(error));
	const withMetadata = candidate as Error & { readonly status?: number; readonly request_id?: string; readonly requestID?: string };
	const metadata = [
		withMetadata.status === undefined ? undefined : `status=${withMetadata.status}`,
		withMetadata.request_id ? `request_id=${withMetadata.request_id}` : undefined,
		withMetadata.requestID ? `request_id=${withMetadata.requestID}` : undefined,
	].filter((value): value is string => value !== undefined);
	let message = `${candidate.name}: ${candidate.message}`;
	if (metadata.length > 0) message += ` (${metadata.join(", ")})`;
	if (apiKey) message = message.replaceAll(apiKey, "[REDACTED]");
	return message.replace(/Bearer\s+[^\s,;]+/giu, "Bearer [REDACTED]");
}

export class ChatCompletionsAdapter {
	readonly #apiKey: string;
	readonly #client: OpenAI;
	readonly #config: AdapterRequestConfig;
	readonly #retryPolicy;

	constructor(options: ChatCompletionsAdapterOptions) {
		requireConfigValue(options.apiKey, "apiKey");
		requireConfigValue(options.model.id, "model.id");
		requireConfigValue(options.model.provider, "model.provider");
		requireConfigValue(options.model.api, "model.api");
		requireConfigValue(options.model.baseUrl, "model.baseUrl");
		try {
			new URL(options.model.baseUrl);
		} catch (cause) {
			throw new ChatCompletionsConfigError("model.baseUrl must be a valid URL.", { cause });
		}
		this.#apiKey = options.apiKey;
		const reasoningFields = validateReasoningFields(options.reasoningFields ?? DEFAULT_REASONING_FIELDS);
		const model = Object.freeze({ ...options.model });
		this.#config = Object.freeze({
			model,
			includeUsage: options.includeUsage !== false,
			reasoningFields,
		});
		this.#retryPolicy = normalizeRetryPolicy(options.retry);
		this.#client = new OpenAI({
			apiKey: options.apiKey,
			baseURL: model.baseUrl.replace(/\/+$/u, ""),
			defaultHeaders: normalizeHeaders(options.headers),
			fetch: options.fetch,
			maxRetries: 0,
			timeout: options.timeoutMs,
		});
	}

	stream(context: Context, options: ChatCompletionsRunOptions): AssistantEventStream {
		const initialPayload = buildPayload(context, this.#config, options);
		const stream = new AssistantEventStreamImpl();
		const accumulator = new ResponseAccumulator(this.#config.model, this.#config.reasoningFields, stream);
		void this.#pump(initialPayload, options, accumulator, stream);
		return stream;
	}

	complete(context: Context, options: ChatCompletionsRunOptions) {
		return this.stream(context, options).result();
	}

	async #pump(
		initialPayload: ChatCompletionCreateParamsStreaming,
		options: ChatCompletionsRunOptions,
		accumulator: ResponseAccumulator,
		stream: AssistantEventStreamImpl,
	): Promise<void> {
		let attempts = 0;
		let retryExhausted = false;
		let requestId: string | undefined;
		try {
			options.signal.throwIfAborted();
			const replacement = await options.onPayload?.(initialPayload);
			const payload = replacement ?? initialPayload;
			let upstream: AsyncIterable<ChatCompletionChunk> | undefined;
			let response: Response | undefined;
			while (!upstream || !response) {
				options.signal.throwIfAborted();
				attempts++;
				try {
					const created = await this.#client.chat.completions
						.create(payload, { signal: options.signal, maxRetries: 0 })
						.withResponse();
					upstream = created.data;
					response = created.response;
					retryExhausted = false;
					requestId = undefined;
				} catch (error) {
					const decision = decideRetry({
						error,
						signal: options.signal,
						attempt: attempts,
						policy: this.#retryPolicy,
					});
					retryExhausted = decision.exhausted;
					requestId = decision.requestId;
					if (!decision.retry || !decision.event) throw error;
					try {
						await options.onRetry?.(decision.event);
					} catch (hookError) {
						retryExhausted = false;
						throw hookError;
					}
					await abortableSleep(decision.event.delayMs, options.signal);
				}
			}
			await options.onResponse?.({
				status: response.status,
				headers: Object.fromEntries(response.headers.entries()),
			});
			options.signal.throwIfAborted();
			accumulator.start();
			for await (const chunk of upstream) {
				options.signal.throwIfAborted();
				accumulator.accept(chunk);
			}
			options.signal.throwIfAborted();
			accumulator.finish();
		} catch (error) {
			accumulator.fail(error, options.signal.aborted, formatAdapterError(error, this.#apiKey), {
				...(attempts > 0 ? { attempts, retryExhausted } : {}),
				...(requestId ? { requestId } : {}),
			});
		} finally {
			if (accumulator.state === "completed" || accumulator.state === "failed") stream.end(accumulator.message);
		}
	}
}
