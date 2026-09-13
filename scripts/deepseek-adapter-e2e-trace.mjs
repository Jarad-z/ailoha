import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { InMemoryTraceSink, Session } from "@ailoha/agent-core";
import { createCalculatorTool } from "@ailoha/agent-tools";
import { ChatCompletionsAdapter } from "@ailoha/chat-completions-adapter";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is missing. Copy .env.example to .env.local and set your key.");

const model = {
	id: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
	name: "DeepSeek E2E Model",
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
let sequence = 0;
let modelCall = 0;
const records = [];
const record = (type, data) => {
	records.push({ sequence: ++sequence, elapsedMs: Date.now() - startedAt, type, ...data });
};

const coreTrace = new InMemoryTraceSink();
const coreSink = {
	emit(event) {
		coreTrace.emit(event);
		record(event.type, { source: "agent-core", event });
	},
};

const adapter = new ChatCompletionsAdapter({ model, apiKey });
const modelRunner = {
	async run(context, { signal }) {
		const call = ++modelCall;
		const stream = adapter.stream({
			systemPrompt: context.systemPrompt,
			messages: [...context.messages],
			tools: [...context.tools],
		}, {
			signal,
			onPayload(payload) {
				record("model.request", {
					source: "chat-completions-adapter",
					modelCall: call,
					method: "POST",
					url: `${model.baseUrl.replace(/\/+$/u, "")}/chat/completions`,
					payload,
				});
			},
			onResponse(response) {
				record("model.response", {
					source: "chat-completions-adapter",
					modelCall: call,
					status: response.status,
					requestId: response.headers["x-request-id"] ?? response.headers["x-ds-request-id"],
					contentType: response.headers["content-type"],
				});
			},
		});

		const eventDrain = (async () => {
			for await (const event of stream) {
				const data = { source: "chat-completions-adapter", modelCall: call, eventType: event.type };
				if ("contentIndex" in event) data.contentIndex = event.contentIndex;
				if ("delta" in event) data.delta = event.delta;
				if (event.type === "done") {
					data.reason = event.reason;
					data.message = event.message;
				} else if (event.type === "error") {
					data.reason = event.reason;
					data.message = event.error;
				} else if (event.type === "toolcall_end") {
					data.toolCall = event.toolCall;
				} else if (event.type === "text_end" || event.type === "thinking_end") {
					data.content = event.content;
				}
				record("model.stream.event", data);
			}
		})();
		const message = await stream.result();
		await eventDrain;
		record("model.result", { source: "chat-completions-adapter", modelCall: call, message });
		return message;
	},
};

const session = await Session.create({
	model,
	createModelRunner: () => modelRunner,
	contextManagerOptions: {
		systemPrompts: [
			"You are an end-to-end adapter test. You must call the calculator tool exactly once for arithmetic, then answer briefly with the numeric result.",
		],
	},
	configureTools: (manager) => manager.register("calculator", () => createCalculatorTool()),
	toolRequests: [{ name: "calculator" }],
	trace: { sink: coreSink, sinkOwnership: "external", capture: { arguments: "full", results: "full" } },
});

try {
	const result = await session.agent.prompt("请调用 calculator 计算 (137 * 42) + 19，并只用一句话告诉我结果。", {
		runId: `adapter_e2e_${startedAt}`,
		correlationId: `live_${startedAt}`,
	});
	record("e2e.result", {
		source: "script",
		runId: result.runId,
		finalAssistantMessage: result.finalAssistantMessage,
		messageRoles: result.messages.map((message) => message.role),
	});

	const outputDirectory = resolve("artifacts");
	const tracePath = resolve(outputDirectory, "chat-completions-adapter-e2e-trace.jsonl");
	await mkdir(outputDirectory, { recursive: true });
	await writeFile(tracePath, `${records.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
	console.log(JSON.stringify({
		tracePath,
		runId: result.runId,
		modelCalls: modelCall,
		coreTraceEvents: coreTrace.snapshot().length,
		traceRecords: records.length,
		answer: result.finalAssistantMessage?.content.filter((block) => block.type === "text").map((block) => block.text).join(""),
	}, null, 2));
} finally {
	await session.dispose();
}
