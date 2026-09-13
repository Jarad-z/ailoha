import { Type } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { ChatCompletionsAdapter } from "../src/adapter.js";
import { ChatCompletionsConfigError, ChatCompletionsProtocolError, UnsupportedContentError } from "../src/errors.js";
import { buildPayload } from "../src/request.js";
import type { AdapterRequestConfig } from "../src/types.js";
import { DEFAULT_REASONING_FIELDS } from "../src/types.js";
import { MODEL, NOW, ZERO_USAGE } from "./fixtures.js";

const config: AdapterRequestConfig = {
	model: MODEL,
	includeUsage: true,
	reasoningFields: DEFAULT_REASONING_FIELDS,
};
const signal = new AbortController().signal;

function payload(context: Context, options: Partial<Parameters<typeof buildPayload>[2]> = {}) {
	return buildPayload(context, config, { signal, ...options });
}

function assistant(content: AssistantMessage["content"], overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: NOW,
		...overrides,
	};
}

describe("Chat Completions request conversion", () => {
	it("converts system and ordered user text while omitting undefined fields", () => {
		const result = payload({
			systemPrompt: "system",
			messages: [{ role: "user", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }], timestamp: NOW }],
		});
		expect(result).toEqual({
			model: MODEL.id,
			messages: [
				{ role: "system", content: "system" },
				{ role: "user", content: "one\ntwo" },
			],
			stream: true,
			n: 1,
			stream_options: { include_usage: true },
		});
		expect(JSON.stringify(result)).not.toContain("undefined");
	});

	it("replays assistant text, tool calls, and same-model reasoning", () => {
		const result = payload({
			messages: [assistant([
				{ type: "thinking", thinking: "plan ", thinkingSignature: "reasoning_content" },
				{ type: "thinking", thinking: "more", thinkingSignature: "reasoning_content" },
				{ type: "text", text: "answer" },
				{ type: "toolCall", id: "call-1", name: "search", arguments: { q: "docs" } },
			])],
		});
		expect(result.messages[0]).toEqual({
			role: "assistant",
			content: "answer",
			reasoning_content: "plan more",
			tool_calls: [{ type: "function", id: "call-1", function: { name: "search", arguments: '{"q":"docs"}' } }],
		});
	});

	it("uses null content for a tool-only assistant message", () => {
		const result = payload({ messages: [assistant([{ type: "toolCall", id: "c", name: "t", arguments: {} }])] });
		expect(result.messages[0]).toMatchObject({ role: "assistant", content: null });
	});

	it("does not replay unknown, cross-provider, or cross-model thinking", () => {
		const messages = [
			assistant([{ type: "thinking", thinking: "private", thinkingSignature: "unknown" }]),
			assistant([{ type: "thinking", thinking: "private", thinkingSignature: "reasoning" }], { provider: "other" }),
			assistant([{ type: "thinking", thinking: "private", thinkingSignature: "reasoning" }], { model: "other" }),
		];
		for (const message of payload({ messages }).messages) {
			expect(message).not.toHaveProperty("reasoning");
			expect(message).not.toHaveProperty("reasoning_content");
		}
	});

	it("rejects conflicting replay signatures", () => {
		expect(() => payload({ messages: [assistant([
			{ type: "thinking", thinking: "a", thinkingSignature: "reasoning" },
			{ type: "thinking", thinking: "b", thinkingSignature: "reasoning_text" },
		])] })).toThrow(ChatCompletionsProtocolError);
	});

	it("converts multiple tool results and the empty-output fallback", () => {
		const toolResults: ToolResultMessage[] = [
			{ role: "toolResult", toolCallId: "a", toolName: "x", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }], isError: false, timestamp: NOW },
			{ role: "toolResult", toolCallId: "b", toolName: "y", content: [], isError: true, timestamp: NOW },
		];
		expect(payload({ messages: toolResults }).messages).toEqual([
			{ role: "tool", tool_call_id: "a", content: "one\ntwo" },
			{ role: "tool", tool_call_id: "b", content: "(no tool output)" },
		]);
	});

	it("converts tools and explicit run options", () => {
		const parameters = Type.Object({ city: Type.String() });
		const result = payload({ messages: [], tools: [{ name: "weather", description: "Weather", parameters }] }, {
			temperature: 0,
			maxTokens: 321,
			toolChoice: "required",
		});
		expect(result).toMatchObject({
			temperature: 0,
			max_tokens: 321,
			tool_choice: "required",
			tools: [{ type: "function", function: { name: "weather", description: "Weather", parameters } }],
		});
	});

	it.each([
		assistant([{ type: "toolCall", id: "", name: "tool", arguments: {} }]),
		assistant([{ type: "toolCall", id: "call", name: "", arguments: {} }]),
	])("rejects empty tool call identity", (message) => {
		expect(() => payload({ messages: [message] })).toThrow(ChatCompletionsProtocolError);
	});

	it("rejects unsupported user and tool-result images before transport", () => {
		expect(() => payload({ messages: [{ role: "user", content: [{ type: "image", data: "x", mimeType: "image/png" }], timestamp: NOW }] })).toThrow(UnsupportedContentError);
		expect(() => payload({ messages: [{ role: "toolResult", toolCallId: "c", toolName: "t", content: [{ type: "image", data: "x", mimeType: "image/png" }], isError: false, timestamp: NOW }] })).toThrow(UnsupportedContentError);
	});

	it("validates config and rejects reserved headers case-insensitively", () => {
		expect(() => new ChatCompletionsAdapter({ model: MODEL, apiKey: " " })).toThrow(ChatCompletionsConfigError);
		expect(() => new ChatCompletionsAdapter({ model: { ...MODEL, baseUrl: "not a url" }, apiKey: "key" })).toThrow(ChatCompletionsConfigError);
		for (const name of ["Authorization", "ACCEPT", "content-Type"]) {
			expect(() => new ChatCompletionsAdapter({ model: MODEL, apiKey: "key", headers: { [name]: "override" } })).toThrow(ChatCompletionsConfigError);
		}
		expect(() => new ChatCompletionsAdapter({ model: MODEL, apiKey: "key", headers: { Authorization: null, "x-provider": "ok" } })).not.toThrow();
	});
});
