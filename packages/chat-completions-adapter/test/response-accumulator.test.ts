import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { describe, expect, it, vi } from "vitest";
import { ChatCompletionsProtocolError } from "../src/errors.js";
import { ResponseAccumulator } from "../src/response-accumulator.js";
import { DEFAULT_REASONING_FIELDS } from "../src/types.js";
import { MODEL, NOW, chunk, usageChunk } from "./fixtures.js";

function harness(reasoningFields = DEFAULT_REASONING_FIELDS) {
	const events: AssistantMessageEvent[] = [];
	const accumulator = new ResponseAccumulator(MODEL, reasoningFields, { push: (event) => events.push(event) });
	accumulator.start();
	return { accumulator, events };
}

function eventTypes(events: readonly AssistantMessageEvent[]) {
	return events.map((event) => event.type);
}

describe("ResponseAccumulator", () => {
	it("emits the complete pure-text lifecycle and preserves object identity", () => {
		vi.spyOn(Date, "now").mockReturnValue(NOW);
		const { accumulator, events } = harness();
		accumulator.accept(chunk({ content: "hel" }));
		accumulator.accept(chunk({ content: "lo" }, "stop"));
		accumulator.finish();
		expect(eventTypes(events)).toEqual(["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
		expect(accumulator.message.content).toEqual([{ type: "text", text: "hello" }]);
		expect(events.every((event) => ("partial" in event ? event.partial === accumulator.message : true))).toBe(true);
		expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop", message: accumulator.message });
		vi.restoreAllMocks();
	});

	it("separates reasoning and text and locks the highest-priority reasoning field", () => {
		const { accumulator, events } = harness();
		accumulator.accept(chunk({ content: "answer", reasoning_content: "first", reasoning: "duplicate" } as ChatCompletionChunk.Choice.Delta));
		accumulator.accept(chunk({ reasoning_content: " second", reasoning: "ignored" } as ChatCompletionChunk.Choice.Delta, "stop"));
		accumulator.finish();
		expect(accumulator.message.content).toEqual([
			{ type: "thinking", thinking: "first second", thinkingSignature: "reasoning_content" },
			{ type: "text", text: "answer" },
		]);
		expect(eventTypes(events)).toEqual([
			"start", "thinking_start", "thinking_delta", "text_start", "text_delta", "thinking_delta", "thinking_end", "text_end", "done",
		]);
	});

	it("honors a custom reasoning priority", () => {
		const { accumulator } = harness(["reasoning", "reasoning_content"]);
		accumulator.accept(chunk({ reasoning_content: "no", reasoning: "yes" } as ChatCompletionChunk.Choice.Delta, "stop"));
		accumulator.finish();
		expect(accumulator.message.content[0]).toEqual({ type: "thinking", thinking: "yes", thinkingSignature: "reasoning" });
	});

	it("aggregates multiple interleaved tool calls with stable indexes", () => {
		const { accumulator, events } = harness();
		accumulator.accept(chunk({ tool_calls: [
			{ index: 0, id: "call-a", type: "function", function: { name: "a", arguments: '{"x"' } },
			{ index: 1, id: "call-b", type: "function", function: { name: "b", arguments: '{"y"' } },
		] }));
		accumulator.accept(chunk({ tool_calls: [
			{ index: 1, function: { arguments: ":2}" } },
			{ index: 0, function: { arguments: ":1}" } },
		] }, "tool_calls"));
		accumulator.finish();
		expect(accumulator.message.content).toEqual([
			{ type: "toolCall", id: "call-a", name: "a", arguments: { x: 1 } },
			{ type: "toolCall", id: "call-b", name: "b", arguments: { y: 2 } },
		]);
		expect(events.filter((event) => event.type === "toolcall_delta").map((event) => event.contentIndex)).toEqual([0, 1, 1, 0]);
		expect(events.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
	});

	it("accepts id and name only in a later delta", () => {
		const { accumulator } = harness();
		accumulator.accept(chunk({ tool_calls: [{ index: 0, function: { arguments: "{}" } }] }));
		accumulator.accept(chunk({ tool_calls: [{ index: 0, id: "late", type: "function", function: { name: "tool" } }] }, "tool_calls"));
		accumulator.finish();
		expect(accumulator.message.content[0]).toEqual({ type: "toolCall", id: "late", name: "tool", arguments: {} });
	});

	it.each([
		["id", { tool_calls: [{ index: 0, id: "other" }] }],
		["name", { tool_calls: [{ index: 0, function: { name: "other" } }] }],
	] as const)("rejects conflicting tool %s", (_label, conflicting) => {
		const { accumulator } = harness();
		accumulator.accept(chunk({ tool_calls: [{ index: 0, id: "call", type: "function", function: { name: "tool", arguments: "{}" } }] }));
		expect(() => accumulator.accept(chunk(conflicting as unknown as ChatCompletionChunk.Choice.Delta))).toThrow(ChatCompletionsProtocolError);
	});

	it.each(["{", "[]", "null", "1", '"text"'])("rejects non-object tool arguments: %s", (argumentsJson) => {
		const { accumulator } = harness();
		accumulator.accept(chunk({ tool_calls: [{ index: 0, id: "call", type: "function", function: { name: "tool", arguments: argumentsJson } }] }, "tool_calls"));
		expect(() => accumulator.finish()).toThrow(ChatCompletionsProtocolError);
	});

	it("processes a usage-only final chunk and response metadata before finalizing", () => {
		const { accumulator, events } = harness();
		accumulator.accept(chunk({ content: "ok" }, "stop", { id: "response-1", model: "served-model" }));
		accumulator.accept(usageChunk({
			prompt_tokens: 20,
			completion_tokens: 7,
			total_tokens: 27,
			prompt_tokens_details: { cached_tokens: 5, cache_write_tokens: 3 } as NonNullable<ChatCompletionChunk["usage"]>["prompt_tokens_details"],
			completion_tokens_details: { reasoning_tokens: 4, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0, audio_tokens: 0 },
		}));
		expect(eventTypes(events)).not.toContain("done");
		accumulator.finish();
		expect(accumulator.message).toMatchObject({
			responseId: "response-1",
			responseModel: "served-model",
			usage: { input: 12, output: 7, cacheRead: 5, cacheWrite: 3, reasoning: 4, totalTokens: 27 },
		});
	});

	it.each([
		["stop", "stop"],
		["end", "stop"],
		["length", "length"],
	] as const)("maps finish_reason %s to %s", (finishReason, expected) => {
		const { accumulator, events } = harness();
		accumulator.accept(chunk({ content: "x" }, finishReason as ChatCompletionChunk.Choice["finish_reason"]));
		accumulator.finish();
		expect(events.at(-1)).toMatchObject({ type: "done", reason: expected });
	});

	it("prefers toolUse when finish_reason is stop and can infer toolUse without a finish reason", () => {
		for (const finishReason of ["stop", null] as const) {
			const { accumulator } = harness();
			accumulator.accept(chunk({ tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "t", arguments: "{}" } }] }, finishReason));
			accumulator.finish();
			expect(accumulator.message.stopReason).toBe("toolUse");
		}
	});

	it.each(["content_filter", "unknown"])("rejects unsuccessful finish_reason %s", (finishReason) => {
		const { accumulator } = harness();
		accumulator.accept(chunk({ content: "partial" }, finishReason as ChatCompletionChunk.Choice["finish_reason"]));
		expect(() => accumulator.finish()).toThrow(ChatCompletionsProtocolError);
	});

	it("rejects missing finish reason, multiple choices, and nonzero choice index", () => {
		const missing = harness().accumulator;
		missing.accept(chunk({ content: "x" }));
		expect(() => missing.finish()).toThrow(ChatCompletionsProtocolError);

		for (const choices of [
			[
				{ index: 0, delta: {}, finish_reason: null, logprobs: null },
				{ index: 1, delta: {}, finish_reason: null, logprobs: null },
			],
			[{ index: 2, delta: {}, finish_reason: null, logprobs: null }],
		]) {
			const { accumulator } = harness();
			expect(() => accumulator.accept({ ...chunk({}), choices })).toThrow(ChatCompletionsProtocolError);
		}
	});
});
