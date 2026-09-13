import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { ChatCompletionsAdapter } from "../src/adapter.js";
import { AssistantEventStreamImpl } from "../src/event-stream.js";
import { EMPTY_CONTEXT, MODEL, ZERO_USAGE, chunk, collect, sseResponse } from "./fixtures.js";

describe("ChatCompletionsAdapter SDK transport", () => {
	it("uses the configured URL, SDK authorization, payload, callbacks, and typed SSE stream", async () => {
		let requestUrl = "";
		let requestBody: Record<string, unknown> = {};
		let authorization = "";
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			requestUrl = request.url;
			authorization = request.headers.get("authorization") ?? "";
			requestBody = JSON.parse(await request.text()) as Record<string, unknown>;
			return sseResponse([chunk({ content: "hello" }, "stop")]);
		};
		const lifecycle: unknown[] = [];
		const adapter = new ChatCompletionsAdapter({ model: MODEL, apiKey: "secret-key", headers: { "x-provider": "value" }, fetch });
		const stream = adapter.stream(EMPTY_CONTEXT, {
			signal: new AbortController().signal,
			onPayload(value) {
				lifecycle.push(["payload", value.model]);
				return { ...value, temperature: 0.25 };
			},
			onResponse(value) {
				lifecycle.push(["response", value.status, value.headers["x-request-id"]]);
			},
		});
		const [events, result] = await Promise.all([collect(stream), stream.result()]);
		expect(requestUrl).toBe("https://provider.test/v1/chat/completions");
		expect(authorization).toBe("Bearer secret-key");
		expect(requestBody).toMatchObject({ model: MODEL.id, stream: true, n: 1, temperature: 0.25 });
		expect(lifecycle).toEqual([["payload", MODEL.id], ["response", 200, "req-test"]]);
		expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		const terminal = events.at(-1);
		expect(terminal?.type).toBe("done");
		if (terminal?.type !== "done") throw new Error("Expected done event.");
		expect(terminal.message).toBe(result);
	});

	it.each([401, 429, 500])("converts SDK HTTP %s before start into one safe terminal error", async (status) => {
		const fetch: typeof globalThis.fetch = async () => new Response(
			JSON.stringify({ error: { message: "failed for super-secret", type: "test" } }),
			{ status, headers: { "content-type": "application/json", "x-request-id": `req-${status}` } },
		);
		const adapter = new ChatCompletionsAdapter({ model: MODEL, apiKey: "super-secret", fetch });
		const stream = adapter.stream(EMPTY_CONTEXT, { signal: new AbortController().signal });
		const events = await collect(stream);
		const result = await stream.result();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "error", reason: "error" });
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(`status=${status}`);
		expect(result.errorMessage).not.toContain("super-secret");
	});

	it("normalizes a provider context-length code for AgentCore recovery", async () => {
		const fetch: typeof globalThis.fetch = async () => new Response(
			JSON.stringify({
				error: {
					message: "request is too large",
					type: "invalid_request_error",
					code: "context_length_exceeded",
				},
			}),
			{ status: 400, headers: { "content-type": "application/json" } },
		);
		const adapter = new ChatCompletionsAdapter({ model: MODEL, apiKey: "key", fetch });
		const result = await adapter.complete(EMPTY_CONTEXT, { signal: new AbortController().signal });

		expect(result.stopReason).toBe("error");
		expect(result.diagnostics).toEqual([
			expect.objectContaining({
				type: "chat_completions_failure",
				error: expect.objectContaining({ code: "CONTEXT_WINDOW_EXCEEDED" }),
				details: expect.objectContaining({
					code: "CONTEXT_WINDOW_EXCEEDED",
					providerCode: "context_length_exceeded",
					status: 400,
				}),
			}),
		]);
	});

	it("preserves partial content when the SDK iterator fails after start", async () => {
		const body = `data: ${JSON.stringify(chunk({ content: "partial" }))}\n\ndata: {invalid-json}\n\n`;
		const fetch: typeof globalThis.fetch = async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		const adapter = new ChatCompletionsAdapter({ model: MODEL, apiKey: "key", fetch });
		const stream = adapter.stream(EMPTY_CONTEXT, { signal: new AbortController().signal });
		const events = await collect(stream);
		const result = await stream.result();
		expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "error"]);
		expect(result.content).toEqual([{ type: "text", text: "partial" }]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("JSON");
	});

	it("reports pre-abort and mid-stream abort as aborted with exactly one terminal event", async () => {
		const preController = new AbortController();
		preController.abort(new DOMException("cancelled", "AbortError"));
		let called = false;
		const neverFetch: typeof globalThis.fetch = async () => {
			called = true;
			throw new Error("unreachable");
		};
		const pre = new ChatCompletionsAdapter({ model: MODEL, apiKey: "key", fetch: neverFetch }).stream(EMPTY_CONTEXT, { signal: preController.signal });
		const preEvents = await collect(pre);
		expect(called).toBe(false);
		expect(preEvents).toHaveLength(1);
		expect(preEvents[0]).toMatchObject({ type: "error", reason: "aborted" });

		const controller = new AbortController();
		const encoder = new TextEncoder();
		let keepOpen!: ReadableStreamDefaultController<Uint8Array>;
		const fetch: typeof globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
			start(streamController) {
				keepOpen = streamController;
				streamController.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({ content: "partial" }))}\n\n`));
			},
			cancel() {},
		}), { status: 200, headers: { "content-type": "text/event-stream" } });
		const mid = new ChatCompletionsAdapter({ model: MODEL, apiKey: "key", fetch }).stream(EMPTY_CONTEXT, { signal: controller.signal });
		const events: AssistantMessageEvent[] = [];
		for await (const event of mid) {
			events.push(event);
			if (event.type === "text_delta") {
				controller.abort(new DOMException("cancelled", "AbortError"));
				keepOpen.error(new Error("transport after abort"));
			}
		}
		const terminal = events.filter((event) => event.type === "done" || event.type === "error");
		expect(terminal).toHaveLength(1);
		expect(terminal[0]).toMatchObject({ type: "error", reason: "aborted" });
		expect((await mid.result()).content).toEqual([{ type: "text", text: "partial" }]);
	});

	it("turns payload and response callback failures into pre-start errors without leaking the API key", async () => {
		const fetch: typeof globalThis.fetch = async () => sseResponse([chunk({ content: "unused" }, "stop")]);
		for (const callback of ["payload", "response"] as const) {
			const adapter = new ChatCompletionsAdapter({ model: MODEL, apiKey: "callback-secret", fetch });
			const stream = adapter.stream(EMPTY_CONTEXT, {
				signal: new AbortController().signal,
				...(callback === "payload" ? { onPayload: () => { throw new Error("callback-secret failed"); } } : {}),
				...(callback === "response" ? { onResponse: () => { throw new Error("callback-secret failed"); } } : {}),
			});
			const events = await collect(stream);
			expect(events.map((event) => event.type)).toEqual(["error"]);
			expect((await stream.result()).errorMessage).toBe("Error: [REDACTED] failed");
		}
	});
});

describe("AssistantEventStreamImpl", () => {
	it("is FIFO, supports concurrent result(), and ends only after delivering the terminal event", async () => {
		const stream = new AssistantEventStreamImpl();
		const message: AssistantMessage = { role: "assistant", content: [], api: MODEL.api, provider: MODEL.provider, model: MODEL.id, usage: ZERO_USAGE, stopReason: "stop", timestamp: 1 };
		const resultPromise = stream.result();
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
		const events = await collect(stream);
		expect(events.map((event) => event.type)).toEqual(["start", "done"]);
		expect(await resultPromise).toBe(message);
	});
});
