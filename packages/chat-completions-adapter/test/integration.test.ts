import { Type } from "@earendil-works/pi-ai";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions.js";
import { Session } from "@ailoha/agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { ChatCompletionsAdapter } from "../src/adapter.js";
import { MODEL, chunk, sseResponse } from "./fixtures.js";

const sessions: Session[] = [];

afterEach(async () => {
	await Promise.allSettled(sessions.splice(0).map(async (session) => await session.dispose()));
});

describe("Agent integration", () => {
	it("runs reasoning -> tool -> tool result -> replayed reasoning -> final text through the unchanged ModelRunner", async () => {
		const payloads: ChatCompletionCreateParamsStreaming[] = [];
		let requestNumber = 0;
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			payloads.push(JSON.parse(await request.text()) as ChatCompletionCreateParamsStreaming);
			requestNumber++;
			if (requestNumber === 1) {
				return sseResponse([
					chunk({ reasoning_content: "I should use the echo tool." } as never),
					chunk({ tool_calls: [{ index: 0, id: "call-echo", type: "function", function: { name: "echo", arguments: '{"text":"hello"}' } }] }, "tool_calls"),
				]);
			}
			return sseResponse([chunk({ content: "The tool returned hello." }, "stop")]);
		};
		const adapter = new ChatCompletionsAdapter({ model: MODEL, apiKey: "test-key", fetch });
		const session = await Session.create({
			model: MODEL,
			createModelRunner: () => ({
				run: (context, { signal }) => adapter.complete({
					systemPrompt: context.systemPrompt,
					messages: [...context.messages],
					tools: [...context.tools],
				}, { signal }),
			}),
			configureTools(manager) {
				manager.register("echo", () => ({
					name: "echo",
					description: "Echo text",
					parameters: Type.Object({ text: Type.String() }, { additionalProperties: false }),
					async execute(call) { return { content: String(call.arguments.text) }; },
				}));
			},
			toolRequests: [{ name: "echo" }],
		});
		sessions.push(session);
		const result = await session.agent.prompt("echo hello");

		expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const firstAssistant = result.messages[1];
		expect(firstAssistant.role === "assistant" && firstAssistant.content).toEqual([
			{ type: "thinking", thinking: "I should use the echo tool.", thinkingSignature: "reasoning_content" },
			{ type: "toolCall", id: "call-echo", name: "echo", arguments: { text: "hello" } },
		]);
		expect(payloads).toHaveLength(2);
		expect(payloads[1].messages).toContainEqual(expect.objectContaining({
			role: "assistant",
			reasoning_content: "I should use the echo tool.",
			tool_calls: [expect.objectContaining({ id: "call-echo" })],
		}));
		expect(payloads[1].messages).toContainEqual({ role: "tool", tool_call_id: "call-echo", content: "hello" });
		expect(result.finalAssistantMessage?.content).toEqual([{ type: "text", text: "The tool returned hello." }]);
	});
});
