import type { Api, Context, Model, Usage } from "@earendil-works/pi-ai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";

export const NOW = 1_789_123_456_000;

export const MODEL: Model<Api> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "test-provider",
	baseUrl: "https://provider.test/v1/",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_000,
};

export const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export const EMPTY_CONTEXT: Context = { messages: [] };

let chunkCounter = 0;

export function chunk(
	delta: ChatCompletionChunk.Choice.Delta,
	finishReason: ChatCompletionChunk.Choice["finish_reason"] = null,
	extra: Partial<ChatCompletionChunk> = {},
): ChatCompletionChunk {
	chunkCounter++;
	return {
		id: `chunk-${chunkCounter}`,
		choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
		created: 1,
		model: MODEL.id,
		object: "chat.completion.chunk",
		...extra,
	};
}

export function usageChunk(usage: NonNullable<ChatCompletionChunk["usage"]>): ChatCompletionChunk {
	return {
		id: "usage-chunk",
		choices: [],
		created: 1,
		model: MODEL.id,
		object: "chat.completion.chunk",
		usage,
	};
}

export function sseResponse(chunks: readonly ChatCompletionChunk[], init: ResponseInit = {}): Response {
	const body = `${chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("")}data: [DONE]\n\n`;
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream", "x-request-id": "req-test", ...init.headers },
		...init,
	});
}

export async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
	const values: T[] = [];
	for await (const value of stream) values.push(value);
	return values;
}
