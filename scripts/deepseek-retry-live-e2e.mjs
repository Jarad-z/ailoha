import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { InMemoryTraceSink, Session } from "@ailoha/agent-core";
import { ChatCompletionsAdapter } from "@ailoha/chat-completions-adapter";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is missing. Copy .env.example to .env.local and set your key.");

const timeoutMs = Number(process.env.LIVE_E2E_TIMEOUT_MS ?? "120000");
if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("LIVE_E2E_TIMEOUT_MS must be a positive integer.");

const model = {
	id: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
	name: "DeepSeek Retry Live E2E Model",
	api: "openai-completions",
	baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
	provider: "deepseek",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 384_000,
};

const startedAt = Date.now();
const nonce = `RETRY_OK_${startedAt}`;
const artifactPath = resolve("artifacts", "chat-completions-retry-live-e2e.jsonl");
const records = [];
let sequence = 0;
const record = (type, data) => {
	records.push({ sequence: ++sequence, elapsedMs: Date.now() - startedAt, type, ...data });
};

function injectedError(status, code, headers = {}) {
	return new Response(JSON.stringify({
		error: {
			message: "injected retry live e2e failure",
			type: status === 429 ? "rate_limit_error" : "server_error",
			code,
		},
	}), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

const upstreamFetch = globalThis.fetch.bind(globalThis);
let transportAttempts = 0;
let realUpstreamCalls = 0;
const instrumentedFetch = async (input, init) => {
	const attempt = ++transportAttempts;
	if (attempt === 1) {
		record("transport.attempt", { attempt, target: "injected", status: 429 });
		return injectedError(429, "rate_limit_exceeded", {
			"retry-after-ms": "25",
			"x-request-id": "injected-429",
		});
	}
	if (attempt === 2) {
		record("transport.attempt", { attempt, target: "injected", status: 503 });
		return injectedError(503, "server_error", { "x-request-id": "injected-503" });
	}
	if (attempt === 3) {
		realUpstreamCalls++;
		record("transport.attempt", { attempt, target: "real_provider" });
		return await upstreamFetch(input, init);
	}
	throw new Error(`Unexpected transport attempt: ${attempt}`);
};

const retryEvents = [];
const streamEvents = [];
const responseEvents = [];
let payloadCalls = 0;
let modelCalls = 0;
const adapter = new ChatCompletionsAdapter({
	model,
	apiKey,
	fetch: instrumentedFetch,
	retry: {
		maxAttempts: 3,
		baseDelayMs: 10,
		maxDelayMs: 50,
		respectRetryAfter: true,
	},
});

const coreTrace = new InMemoryTraceSink();
const coreSink = {
	emit(event) {
		coreTrace.emit(event);
		record("agent.trace", { event });
	},
};

const modelRunner = {
	async run(context, { signal }) {
		modelCalls++;
		const stream = adapter.stream({
			systemPrompt: context.systemPrompt,
			messages: [...context.messages],
			tools: [...context.tools],
		}, {
			signal,
			onPayload(payload) {
				payloadCalls++;
				record("model.payload", { model: payload.model, stream: payload.stream, messageCount: payload.messages.length });
			},
			onRetry(event) {
				retryEvents.push(event);
				record("adapter.retry", { event });
			},
			onResponse(response) {
				const metadata = {
					status: response.status,
					requestId: response.headers["x-request-id"] ?? response.headers["x-ds-request-id"],
					contentType: response.headers["content-type"],
				};
				responseEvents.push(metadata);
				record("model.response", metadata);
			},
		});
		const drain = (async () => {
			for await (const event of stream) {
				streamEvents.push(event);
				record("model.stream.event", {
					eventType: event.type,
					...(event.type === "done" ? { reason: event.reason } : {}),
					...(event.type === "error" ? { reason: event.reason } : {}),
				});
			}
		})();
		const message = await stream.result();
		await drain;
		return message;
	},
};

const session = await Session.create({
	model,
	createModelRunner: () => modelRunner,
	contextManagerOptions: {
		systemPrompts: [
			"You are a live retry end-to-end test. Follow the user's output-format instruction exactly. Do not call tools. Do not add explanations.",
		],
	},
	trace: { sink: coreSink, sinkOwnership: "external", capture: { requests: "metadata", responses: "metadata" } },
});

let timeout;
let failure;
try {
	timeout = setTimeout(() => session.agent.abort(), timeoutMs);
	const result = await session.agent.prompt(`只回复下面这个标记，不要添加其他内容：${nonce}`, {
		runId: `retry_live_${startedAt}`,
		correlationId: `retry_live_${startedAt}`,
	});
	const finalMessage = result.finalAssistantMessage;
	const answer = finalMessage?.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("")
		.trim() ?? "";
	const terminalEvents = streamEvents.filter((event) => event.type === "done" || event.type === "error");
	const traceEvents = coreTrace.snapshot();
	const countTrace = (type) => traceEvents.filter((event) => event.type === type).length;

	if (transportAttempts !== 3) throw new Error(`Expected 3 transport attempts, received ${transportAttempts}.`);
	if (realUpstreamCalls !== 1) throw new Error(`Expected 1 real provider call, received ${realUpstreamCalls}.`);
	if (retryEvents.length !== 2) throw new Error(`Expected 2 retry events, received ${retryEvents.length}.`);
	if (retryEvents[0].attempt !== 1 || retryEvents[0].nextAttempt !== 2 || retryEvents[0].status !== 429 || retryEvents[0].delayMs !== 25) {
		throw new Error(`Unexpected first retry event: ${JSON.stringify(retryEvents[0])}`);
	}
	if (retryEvents[1].attempt !== 2 || retryEvents[1].nextAttempt !== 3 || retryEvents[1].status !== 503) {
		throw new Error(`Unexpected second retry event: ${JSON.stringify(retryEvents[1])}`);
	}
	if (retryEvents[1].delayMs < 0 || retryEvents[1].delayMs > 20) {
		throw new Error(`Second retry delay is outside 0..20ms: ${retryEvents[1].delayMs}`);
	}
	if (payloadCalls !== 1 || responseEvents.length !== 1 || responseEvents[0].status !== 200) {
		throw new Error(`Unexpected payload/response lifecycle: payloads=${payloadCalls}, responses=${JSON.stringify(responseEvents)}`);
	}
	if (streamEvents.filter((event) => event.type === "start").length !== 1) throw new Error("Expected exactly one stream start event.");
	if (streamEvents.filter((event) => event.type === "done").length !== 1) throw new Error("Expected exactly one stream done event.");
	if (streamEvents.some((event) => event.type === "error") || terminalEvents.length !== 1) {
		throw new Error(`Unexpected stream terminal events: ${JSON.stringify(terminalEvents.map((event) => event.type))}`);
	}
	if (!finalMessage || finalMessage.stopReason !== "stop") throw new Error(`Unexpected final stop reason: ${finalMessage?.stopReason}`);
	if (!answer.includes(nonce)) throw new Error(`Final answer does not contain nonce ${nonce}: ${answer}`);
	if (finalMessage.usage.totalTokens <= 0) throw new Error(`Expected positive real-model usage: ${JSON.stringify(finalMessage.usage)}`);
	if (!finalMessage.responseId && !responseEvents[0].requestId) throw new Error("Real response has no response or request ID.");
	if (modelCalls !== 1 || countTrace("llm.call.started") !== 1 || countTrace("llm.call.finished") !== 1) {
		throw new Error(`Transport retries leaked into Agent LLM calls: modelCalls=${modelCalls}.`);
	}
	if (countTrace("context.compact.started") !== 0 || countTrace("tool.call.requested") !== 0) {
		throw new Error("Retry recovery unexpectedly compacted context or requested a tool.");
	}
	if (countTrace("agent.run.started") !== 1 || countTrace("agent.run.finished") !== 1) {
		throw new Error("Agent Run lifecycle is incomplete.");
	}
	const runFinished = traceEvents.find((event) => event.type === "agent.run.finished");
	if (runFinished?.outcome !== "success" || runFinished.assistantTurnCount !== 1) {
		throw new Error(`Agent Run did not finish as one successful turn: ${JSON.stringify(runFinished)}`);
	}

	record("e2e.result", {
		modelId: model.id,
		runId: result.runId,
		transportAttempts,
		realUpstreamCalls,
		retryCount: retryEvents.length,
		modelCalls,
		answer,
		totalTokens: finalMessage.usage.totalTokens,
		containsSecrets: false,
	});
} catch (error) {
	failure = error;
	record("e2e.failure", {
		name: error instanceof Error ? error.name : "Error",
		message: error instanceof Error ? error.message : String(error),
	});
} finally {
	clearTimeout(timeout);
	await session.dispose();
	await mkdir(resolve("artifacts"), { recursive: true });
	const artifact = `${records.map((item) => JSON.stringify(item)).join("\n")}\n`;
	if (artifact.includes(apiKey) || /Bearer\s+[^\s,;]+/iu.test(artifact)) {
		throw new Error("Retry live E2E artifact contains authentication material; artifact was not written.");
	}
	await writeFile(artifactPath, artifact, "utf8");
}

if (failure) throw failure;
console.log(JSON.stringify({
	status: "passed",
	modelId: model.id,
	artifactPath,
	transportAttempts,
	realUpstreamCalls,
	retryEvents: retryEvents.map(({ attempt, nextAttempt, delayMs, reason, status }) => ({ attempt, nextAttempt, delayMs, reason, status })),
}, null, 2));
