import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	CONTEXT_CHECKPOINT_PREFIX,
	DefaultContextManager,
	Session,
} from "@ailoha/agent-core";
import { ChatCompletionsAdapter } from "@ailoha/chat-completions-adapter";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is missing.");

const model = {
	id: process.env.DEEPSEEK_COMPACTION_MODEL || "deepseek-chat",
	name: "DeepSeek Context Compaction E2E",
	api: "openai-completions",
	baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
	provider: "deepseek",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 4_096,
};

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const user = (content, timestamp) => ({ role: "user", content, timestamp });
const historicalAssistant = (text, timestamp) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: model.api,
	provider: model.provider,
	model: model.id,
	usage: zeroUsage,
	stopReason: "stop",
	timestamp,
});

function messageText(message) {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function estimateContext(context) {
	const serialized = JSON.stringify({
		systemPrompt: context.systemPrompt,
		messages: context.messages,
		tools: context.tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		})),
	});
	return {
		inputTokens: Math.ceil(serialized.length / 4),
		projectionKey: "deepseek-chat-json-char-estimate-v1",
	};
}

function stripJsonFence(text) {
	const trimmed = text.trim();
	if (!trimmed.startsWith("```")) return trimmed;
	return trimmed.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
}

const adapter = new ChatCompletionsAdapter({ model, apiKey, timeoutMs: 90_000 });
let summaryProviderCalls = 0;
let businessProviderCalls = 0;

const summaryRunner = {
	async run(input) {
		summaryProviderCalls++;
		const message = await adapter.complete(
			{
				systemPrompt: input.systemPrompt,
				messages: [user(input.data, Date.now())],
				tools: [],
			},
			{
				signal: input.signal,
				maxTokens: input.maxOutputTokens,
				temperature: 0,
				toolChoice: "none",
				onPayload(payload) {
					return { ...payload, response_format: { type: "json_object" } };
				},
			},
		);
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new Error(`DeepSeek summary failed: ${message.errorMessage ?? message.stopReason}`);
		}
		const text = messageText(message);
		if (!text) throw new Error("DeepSeek summary returned no text.");
		if (process.env.COMPACTION_E2E_DEBUG === "1") {
			console.error("SUMMARY_DEBUG", stripJsonFence(text));
		}
		return {
			text: stripJsonFence(text),
			stopReason: message.stopReason === "length" ? "length" : "stop",
			usage: {
				inputTokens: message.usage.input,
				outputTokens: message.usage.output,
				cacheReadTokens: message.usage.cacheRead,
				cacheWriteTokens: message.usage.cacheWrite,
				reasoningTokens: message.usage.reasoning,
				totalTokens: message.usage.totalTokens,
			},
		};
	},
};

function compactionOptions() {
	return {
		model,
		requestOutputTokens: 1_000,
		autoCompactTokenLimit: 1_500,
		targetInputTokens: 1_000,
		safetyMarginTokens: 2_000,
		headroomTokens: 500,
		keepRecentSteps: 0,
		summaryMaxOutputTokens: 2_000,
		tokenEstimator: { estimate: ({ context }) => estimateContext(context) },
		summaryRunner,
	};
}

function businessRunner(options = {}) {
	let attempt = 0;
	return {
		get attempts() {
			return attempt;
		},
		async run(context, { signal }) {
			attempt++;
			if (options.injectOverflow && attempt === 1) {
				return {
					...historicalAssistant("", Date.now()),
					stopReason: "error",
					errorMessage: "Injected classified context overflow for recovery-path testing.",
					diagnostics: [{
						type: "live_e2e_injected_overflow",
						timestamp: Date.now(),
						error: { message: "injected overflow", code: "CONTEXT_WINDOW_EXCEEDED" },
					}],
				};
			}
			businessProviderCalls++;
			return await adapter.complete(
				{
					systemPrompt: context.systemPrompt,
					messages: [...context.messages],
					tools: [...context.tools],
				},
				{ signal, maxTokens: 120, temperature: 0, toolChoice: "none" },
			);
		},
	};
}

function assertCheckpointAndLatest(messages, latest) {
	const checkpoint = messages.find(
		(message) => message.role === "user" && typeof message.content === "string" && message.content.startsWith(CONTEXT_CHECKPOINT_PREFIX),
	);
	if (!checkpoint) throw new Error("Compacted context does not contain a checkpoint.");
	if (!messages.some((message) => message === latest || (
		message.role === "user" && message.timestamp === latest.timestamp && messageText(message) === messageText(latest)
	))) {
		throw new Error("Latest user message was not preserved verbatim.");
	}
	JSON.parse(checkpoint.content.slice(CONTEXT_CHECKPOINT_PREFIX.length + 1, -"</context_checkpoint>".length - 1));
}

async function thresholdCase() {
	const latest = user("请简短确认：你已经读取了压缩后的上下文。", 30);
	const oldConstraint = "历史约束：所有回答必须简洁，并保留任务编号 TASK-ALPHA-17。";
	const history = [
		user(`${oldConstraint}\n${"旧背景资料。".repeat(900)}`, 10),
		historicalAssistant(`已记录 TASK-ALPHA-17。${"旧执行过程。".repeat(700)}`, 20),
	];
	const runner = businessRunner();
	const session = await Session.create({
		model,
		createModelRunner: () => runner,
		contextManagerOptions: {
			systemPrompts: ["你正在执行真实模型的上下文压缩 E2E。回答必须简短。"],
			messages: history,
			compaction: compactionOptions(),
		},
	});
	try {
		const result = await session.agent.prompt(latest);
		assertCheckpointAndLatest(result.messages, latest);
		return {
			case: "before_llm_threshold",
			passed: true,
			businessAttempts: runner.attempts,
			messageRoles: result.messages.map((message) => message.role),
			answer: messageText(result.finalAssistantMessage),
		};
	} finally {
		await session.dispose();
	}
}

async function recoveryCase() {
	const latest = user("请简短确认：溢出恢复完成，且当前消息仍然存在。", 130);
	const runner = businessRunner({ injectOverflow: true });
	const session = await Session.create({
		model,
		createModelRunner: () => runner,
		contextManagerOptions: {
			systemPrompts: ["你正在执行真实模型的上下文溢出恢复 E2E。回答必须简短。"],
			messages: [
				user(`旧任务状态 RECOVERY-9。${"历史内容。".repeat(100)}`, 110),
				historicalAssistant(`旧执行结果。${"过程。".repeat(100)}`, 120),
			],
			compaction: compactionOptions(),
		},
	});
	try {
		const result = await session.agent.prompt(latest);
		assertCheckpointAndLatest(result.messages, latest);
		if (runner.attempts !== 2) throw new Error(`Expected two business attempts, received ${runner.attempts}.`);
		return {
			case: "llm_error_recovery",
			passed: true,
			businessAttempts: runner.attempts,
			providerBusinessCalls: 1,
			messageRoles: result.messages.map((message) => message.role),
			answer: messageText(result.finalAssistantMessage),
		};
	} finally {
		await session.dispose();
	}
}

async function manualCase() {
	const latest = user("手动压缩必须保留这条最新用户消息 MANUAL-KEEP-3。", 230);
	const runner = businessRunner();
	const contextManager = new DefaultContextManager({
		systemPrompts: ["你正在执行真实模型的手动上下文压缩 E2E。"],
		messages: [
			user(`旧手动压缩资料。${"旧资料。".repeat(100)}`, 210),
			historicalAssistant(`旧回答。${"旧过程。".repeat(100)}`, 220),
			latest,
		],
		compaction: compactionOptions(),
	});
	const session = await Session.create({
		model,
		createModelRunner: () => runner,
		createContextManager: () => contextManager,
	});
	try {
		const result = await session.agent.compact();
		assertCheckpointAndLatest(contextManager.snapshot().messages, latest);
		if (runner.attempts !== 0) throw new Error("Manual compaction unexpectedly called the business model.");
		return {
			case: "manual_idle",
			passed: true,
			businessAttempts: runner.attempts,
			turnCount: contextManager.turnCount,
			beforeTokens: result.beforeTokens,
			afterTokens: result.afterTokens,
			trigger: result.trigger,
		};
	} finally {
		await session.dispose();
	}
}

const startedAt = Date.now();
const summariesBefore = summaryProviderCalls;
const results = [];
results.push(await thresholdCase());
results.push(await recoveryCase());
results.push(await manualCase());

const report = {
	modelId: model.id,
	passed: results.every((result) => result.passed),
	durationMs: Date.now() - startedAt,
	summaryProviderCalls: summaryProviderCalls - summariesBefore,
	businessProviderCalls,
	cases: results,
};
const reportPath = resolve("artifacts", "deepseek-context-compaction-live-e2e.json");
await mkdir(resolve("artifacts"), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ...report, reportPath }, null, 2));
