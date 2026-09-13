import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	Agent,
	CONTEXT_CHECKPOINT_PREFIX,
	DefaultContextManager,
	ToolManager,
} from "../src/index.js";
import type {
	AgentContext,
	AgentInputMessage,
	AgentMessage,
	AgentModel,
	ContextCheckpoint,
	ContextCompactionOptions,
	ContextTokenEstimator,
	ModelRunner,
	SummaryRunner,
} from "../src/index.js";

const USAGE: Usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const MODEL: AgentModel = {
	id: "compaction-e2e",
	name: "Compaction E2E",
	api: "test-api",
	provider: "test-provider",
	baseUrl: "https://invalid.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_000,
};

const user = (content: string, timestamp = 1): AgentInputMessage => ({ role: "user", content, timestamp });
const assistant = (text: string, timestamp = 1): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: MODEL.api,
	provider: MODEL.provider,
	model: MODEL.id,
	usage: USAGE,
	stopReason: "stop",
	timestamp,
});

const CHECKPOINT: ContextCheckpoint = {
	version: 1,
	objective: "Continue the current user task",
	userConstraints: [],
	decisions: [],
	progress: [],
	nextSteps: ["Answer the retained latest user message"],
	criticalFacts: [],
	artifacts: [],
	openQuestions: [],
};

const characterEstimator: ContextTokenEstimator = {
	estimate({ context }) {
		return {
			inputTokens:
				context.systemPrompt.length +
				context.messages.reduce((total, message) => total + JSON.stringify(message).length, 0) +
				context.tools.reduce((total, tool) => total + JSON.stringify(tool.parameters).length + tool.name.length, 0),
			projectionKey: "test-character-estimator-v1",
		};
	},
};

function compaction(summaryRunner: SummaryRunner): ContextCompactionOptions {
	return {
		model: MODEL,
		requestOutputTokens: 1_000,
		autoCompactTokenLimit: 3_000,
		targetInputTokens: 1_000,
		safetyMarginTokens: 500,
		headroomTokens: 500,
		keepRecentSteps: 0,
		summaryMaxOutputTokens: 500,
		tokenEstimator: characterEstimator,
		summaryRunner,
	};
}

function summaryRunner() {
	return {
		run: vi.fn(async () => ({ text: JSON.stringify(CHECKPOINT), stopReason: "stop" as const })),
	} satisfies SummaryRunner;
}

async function createAgent(contextManager: DefaultContextManager, modelRunner: ModelRunner): Promise<Agent> {
	const tools = new ToolManager();
	await tools.initialize([], { sessionId: "compaction-e2e", model: MODEL, signal: new AbortController().signal });
	return new Agent({
		sessionId: "compaction-e2e",
		model: MODEL,
		modelRunner,
		contextManager,
		toolManager: tools,
	});
}

function expectCheckpointAndLatest(messages: readonly AgentMessage[], latest: AgentInputMessage): void {
	expect(messages).toHaveLength(2);
	expect(messages[0]).toMatchObject({ role: "user" });
	expect((messages[0] as AgentInputMessage).content).toEqual(expect.stringContaining(CONTEXT_CHECKPOINT_PREFIX));
	expect(messages[1]).toEqual(latest);
}

describe("AgentCore built-in context compaction E2E", () => {
	it("compacts before the model call when the input reaches the automatic threshold", async () => {
		const summaries = summaryRunner();
		const latest = user("Keep this current request verbatim", 3);
		const contextManager = new DefaultContextManager({
			systemPrompts: ["System rules"],
			messages: [user("old requirement ".repeat(150), 1), assistant("old progress ".repeat(150), 2)],
			compaction: compaction(summaries),
		});
		const seen: AgentContext[] = [];
		const agent = await createAgent(contextManager, {
			async run(context) {
				seen.push({ ...context, messages: [...context.messages] });
				return assistant("done", 4);
			},
		});

		const result = await agent.prompt(latest);

		expect(summaries.run).toHaveBeenCalledTimes(1);
		expectCheckpointAndLatest(seen[0].messages, latest);
		expect(result.finalAssistantMessage).toMatchObject({ content: [{ text: "done" }] });
		await agent.dispose();
	});

	it("compacts and retries once after a classified context-window overflow", async () => {
		const summaries = summaryRunner();
		const latest = user("Retry my current request without changing it", 3);
		const contextManager = new DefaultContextManager({
			messages: [user("old requirement ".repeat(20), 1), assistant("old result ".repeat(20), 2)],
			compaction: compaction(summaries),
		});
		const seen: AgentContext[] = [];
		let attempt = 0;
		const agent = await createAgent(contextManager, {
			async run(context) {
				seen.push({ ...context, messages: [...context.messages] });
				attempt++;
				if (attempt === 1) {
					return {
						...assistant("", 3),
						stopReason: "error",
						errorMessage: "provider says the request is too large",
						diagnostics: [{
							type: "chat_completions_failure",
							timestamp: 3,
							error: { message: "provider says the request is too large", code: "CONTEXT_WINDOW_EXCEEDED" },
						}],
					};
				}
				return assistant("recovered", 4);
			},
		});

		const result = await agent.prompt(latest);

		expect(seen).toHaveLength(2);
		expect(summaries.run).toHaveBeenCalledTimes(1);
		expectCheckpointAndLatest(seen[1].messages, latest);
		expect(result.finalAssistantMessage).toMatchObject({ content: [{ text: "recovered" }] });
		await agent.dispose();
	});

	it("manually compacts an idle agent without consuming a model turn", async () => {
		const summaries = summaryRunner();
		const latest = user("This is the latest user input and must stay exact", 3);
		const contextManager = new DefaultContextManager({
			messages: [user("older question", 1), assistant("older answer", 2), latest],
			maxTurns: 2,
			compaction: compaction(summaries),
		});
		const businessRunner = vi.fn(async () => assistant("must not be called"));
		const agent = await createAgent(contextManager, { run: businessRunner });

		const result = await agent.compact();

		expect(result).toMatchObject({ changed: true, trigger: "manual", summaryCallCount: 1 });
		expect(summaries.run).toHaveBeenCalledTimes(1);
		expect(businessRunner).not.toHaveBeenCalled();
		expect(contextManager.turnCount).toBe(0);
		expectCheckpointAndLatest(contextManager.snapshot().messages, latest);
		expect(agent.state.status).toBe("idle");
		await agent.dispose();
	});
});
