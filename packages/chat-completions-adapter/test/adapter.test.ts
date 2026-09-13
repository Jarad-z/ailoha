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

	it.each([400, 401, 403, 404, 422])("does not retry permanent SDK HTTP %s errors", async (status) => {
		let requests = 0;
		const fetch: typeof globalThis.fetch = async () => new Response(
			JSON.stringify({ error: { message: "failed for super-secret", type: "test" } }),
			{ status, headers: { "content-type": "application/json", "x-request-id": `req-${status}` } },
		);
		const adapter = new ChatCompletionsAdapter({
			model: MODEL,
			apiKey: "super-secret",
			fetch: async (input, init) => {
				requests++;
				return await fetch(input, init);
			},
		});
		const stream = adapter.stream(EMPTY_CONTEXT, { signal: new AbortController().signal });
		const events = await collect(stream);
		const result = await stream.result();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "error", reason: "error" });
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(`status=${status}`);
		expect(result.errorMessage).not.toContain("super-secret");
		expect(requests).toBe(1);
	});

	it("retries retryable HTTP failures before start and emits only the successful stream", async () => {
		let requests = 0;
		let payloadCalls = 0;
		let responseCalls = 0;
		const retries: unknown[] = [];
		const fetch: typeof globalThis.fetch = async () => {
			requests++;
			if (requests === 1) {
				return new Response(JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } }), {
					status: 429,
					headers: { "content-type": "application/json", "retry-after-ms": "0", "x-request-id": "retry-1" },
				});
			}
			if (requests === 2) {
				return new Response(JSON.stringify({ error: { message: "unavailable", type: "server_error" } }), {
					status: 503,
					headers: { "content-type": "application/json", "x-request-id": "retry-2" },
				});
			}
			return sseResponse([chunk({ content: "recovered" }, "stop")]);
		};
		const adapter = new ChatCompletionsAdapter({
			model: MODEL,
			apiKey: "key",
			fetch,
			retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
		});
		const stream = adapter.stream(EMPTY_CONTEXT, {
			signal: new AbortController().signal,
			onPayload(payload) {
				payloadCalls++;
				return payload;
			},
			onResponse() {
				responseCalls++;
			},
			onRetry(event) {
				retries.push(event);
			},
		});
		const events = await collect(stream);
		const result = await stream.result();

		expect(requests).toBe(3);
		expect(payloadCalls).toBe(1);
		expect(responseCalls).toBe(1);
		expect(retries).toEqual([
			expect.objectContaining({ attempt: 1, nextAttempt: 2, delayMs: 0, reason: "http_status", status: 429 }),
			expect.objectContaining({ attempt: 2, nextAttempt: 3, delayMs: 0, reason: "http_status", status: 503 }),
		]);
		expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
		expect(result).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "recovered" }] });
	});

	it("stops after maxAttempts and reports exhausted retry diagnostics", async () => {
		let requests = 0;
		const adapter = new ChatCompletionsAdapter({
			model: MODEL,
			apiKey: "key",
			retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
			fetch: async () => {
				requests++;
				return new Response(JSON.stringify({ error: { message: "unavailable", type: "server_error" } }), {
					status: 503,
					headers: { "content-type": "application/json", "x-request-id": `attempt-${requests}` },
				});
			},
		});
		const result = await adapter.complete(EMPTY_CONTEXT, { signal: new AbortController().signal });

		expect(requests).toBe(3);
		expect(result.stopReason).toBe("error");
		expect(result.diagnostics?.[0]?.details).toMatchObject({
			status: 503,
			attempts: 3,
			retryExhausted: true,
			retryable: false,
			requestId: "attempt-3",
		});
	});

	it("aborts an in-progress backoff without sending another request", async () => {
		const controller = new AbortController();
		let requests = 0;
		const adapter = new ChatCompletionsAdapter({
			model: MODEL,
			apiKey: "key",
			retry: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 1_000 },
			fetch: async () => {
				requests++;
				return new Response(JSON.stringify({ error: { message: "unavailable", type: "server_error" } }), {
					status: 503,
					headers: { "content-type": "application/json" },
				});
			},
		});
		const stream = adapter.stream(EMPTY_CONTEXT, {
			signal: controller.signal,
			onRetry() {
				controller.abort(new DOMException("cancelled", "AbortError"));
			},
		});
		const events = await collect(stream);

		expect(requests).toBe(1);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "error", reason: "aborted" });
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
		let requests = 0;
		const body = `data: ${JSON.stringify(chunk({ content: "partial" }))}\n\ndata: {invalid-json}\n\n`;
		const fetch: typeof globalThis.fetch = async () => {
			requests++;
			return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		};
		const adapter = new ChatCompletionsAdapter({ model: MODEL, apiKey: "key", fetch });
		const stream = adapter.stream(EMPTY_CONTEXT, { signal: new AbortController().signal });
		const events = await collect(stream);
		const result = await stream.result();
		expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "error"]);
		expect(result.content).toEqual([{ type: "text", text: "partial" }]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("JSON");
		expect(requests).toBe(1);
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
