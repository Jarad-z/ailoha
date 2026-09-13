import type { AssistantMessage, Message, ToolCall, Usage } from "@earendil-works/pi-ai";
import {
	AgentTurnLimitError,
	InMemoryTraceSink,
	Session,
	type AgentContext,
	type AgentModel,
	type Compactor,
	type ModelRunner,
} from "@ailoha/agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { registerAgentTools } from "../src/index.js";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const MODEL: AgentModel = {
	id: "scripted-e2e-model",
	name: "Scripted E2E Model",
	api: "test-api",
	provider: "test-provider",
	baseUrl: "https://invalid.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_000,
};

type ScriptStep = (context: AgentContext) => AssistantMessage | Promise<AssistantMessage>;

class ScriptedModelRunner implements ModelRunner {
	readonly requests: Array<{ readonly messages: readonly Message[]; readonly tools: readonly string[] }> = [];
	readonly #steps: readonly ScriptStep[];
	#cursor = 0;

	constructor(steps: readonly ScriptStep[]) {
		this.#steps = steps;
	}

	async run(context: AgentContext): Promise<AssistantMessage> {
		this.requests.push({
			messages: structuredClone(context.messages),
			tools: context.tools.map((tool) => tool.name),
		});
		const step = this.#steps[this.#cursor++];
		if (!step) throw new Error("ScriptedModelRunner: model call exceeded the test script.");
		return await step(context);
	}

	assertConsumed(): void {
		expect(this.#cursor).toBe(this.#steps.length);
	}
}

function assistant(text: string, calls: readonly ToolCall[] = []): AssistantMessage {
	return {
		role: "assistant",
		content: calls.length > 0 ? [...calls] : [{ type: "text", text }],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: ZERO_USAGE,
		stopReason: calls.length > 0 ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

function call(id: string, name: string, argumentsValue: Record<string, unknown>): ToolCall {
	return { type: "toolCall", id, name, arguments: argumentsValue };
}

function serializedMessages(context: AgentContext): string {
	return JSON.stringify(context.messages);
}

function toolResultText(context: AgentContext, toolCallId: string): string {
	const result = context.messages.find(
		(message) => message.role === "toolResult" && message.toolCallId === toolCallId,
	);
	if (!result) throw new Error(`Missing tool result: ${toolCallId}`);
	if (typeof result.content === "string") return result.content;
	return result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

function toolResultJson(context: AgentContext, toolCallId: string): Record<string, unknown> {
	return JSON.parse(toolResultText(context, toolCallId)) as Record<string, unknown>;
}

function finalText(message: AssistantMessage | undefined): string {
	return message?.content
		.filter((block): block is Extract<(typeof message.content)[number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("") ?? "";
}

const sessions: Session[] = [];

afterEach(async () => {
	await Promise.allSettled(sessions.splice(0).map(async (session) => await session.dispose()));
});

async function createHarness(
	steps: readonly ScriptStep[],
	options: { readonly maxTurns?: number; readonly compactor?: Compactor; readonly id?: string } = {},
) {
	const runner = new ScriptedModelRunner(steps);
	const traces = new InMemoryTraceSink();
	const session = await Session.create(
		{
			model: MODEL,
			createModelRunner: () => runner,
			contextManagerOptions: {
				maxTurns: options.maxTurns,
				compactor: options.compactor,
			},
			configureTools(manager) {
				registerAgentTools(manager, {
					search: {
						documents: [
							{
								id: "widget-a",
								title: "Widget-A catalog",
								content: "Widget-A costs 19.90 yuan per item.",
								url: "fixture://catalog/widget-a",
							},
						],
					},
					weather: {
						readings: [{ location: "上海", condition: "晴", temperatureC: 26 }],
					},
					readDocs: false,
					todo: false,
				});
			},
			toolRequests: ["calculator", "search", "weather"].map((name) => ({ name })),
			trace: {
				sink: traces,
				capture: { arguments: "full", results: "full", errors: "message" },
			},
		},
		{ id: options.id },
	);
	sessions.push(session);
	return { runner, session, traces };
}

function expectEveryRunAndToolCallTraced(traces: InMemoryTraceSink): void {
	const events = traces.snapshot();
	const starts = events.filter((event) => event.type === "agent.run.started");
	const finishes = events.filter((event) => event.type === "agent.run.finished");
	expect(starts.length).toBeGreaterThan(0);
	expect(finishes).toHaveLength(starts.length);

	for (const start of starts) {
		const matching = finishes.filter(
			(event) => event.runId === start.runId && event.sessionId === start.sessionId,
		);
		expect(matching, `run ${start.runId} must have exactly one terminal trace`).toHaveLength(1);
		expect(matching[0].durationMs).toBeGreaterThanOrEqual(0);
		expect(matching[0].sequence).toBeGreaterThan(start.sequence);
	}

	const requested = events.filter((event) => event.type === "tool.call.requested");
	const toolFinishes = events.filter((event) => event.type === "tool.call.finished");
	for (const request of requested) {
		const matching = toolFinishes.filter(
			(event) =>
				event.runId === request.runId &&
				event.sessionId === request.sessionId &&
				event.toolExecutionId === request.toolExecutionId &&
				event.toolCallId === request.toolCallId,
		);
		expect(matching, `tool call ${request.toolCallId} must have exactly one terminal trace`).toHaveLength(1);
		expect(matching[0].sequence).toBeGreaterThan(request.sequence);
	}
}

describe("Minimal Agent deterministic end-to-end", () => {
	it("answers directly without invoking a tool", async () => {
		const harness = await createHarness([
			async (context) => {
				expect(context.tools.map((tool) => tool.name)).toEqual(["calculator", "search", "weather"]);
				return assistant("TypeScript is JavaScript with a static type system.");
			},
		]);

		const result = await harness.session.agent.prompt("What is TypeScript?", { runId: "run-direct" });

		expect(finalText(result.finalAssistantMessage)).toContain("JavaScript");
		expect(harness.traces.snapshot().filter((event) => event.type.startsWith("tool."))).toHaveLength(0);
			expect(harness.traces.snapshot().at(-1)).toMatchObject({
			type: "agent.run.finished",
			outcome: "success",
			toolCallCount: 0,
		});
		expectEveryRunAndToolCallTraced(harness.traces);
		harness.runner.assertConsumed();
	});

	it("executes calculator, search, and weather and feeds every result to the next model turn", async () => {
		const harness = await createHarness([
			async () => assistant("", [call("calc-1", "calculator", { expression: "23 * 7" })]),
			async (context) => {
				expect(toolResultJson(context, "calc-1")).toMatchObject({ expression: "23 * 7", result: 161 });
				return assistant("23 * 7 = 161");
			},
			async () => assistant("", [call("search-1", "search", { query: "Widget-A price" })]),
			async (context) => {
				expect(toolResultText(context, "search-1")).toContain("19.90");
				return assistant("Widget-A costs 19.90 yuan.");
			},
			async () => assistant("", [call("weather-1", "weather", { location: "上海" })]),
			async (context) => {
				expect(toolResultJson(context, "weather-1")).toMatchObject({
					location: "上海",
					condition: "晴",
					temperature: 26,
				});
				return assistant("上海晴，26°C。");
			},
		]);

		const calculator = await harness.session.agent.prompt("Calculate 23 * 7");
		const search = await harness.session.agent.prompt("Find the Widget-A price");
		const weather = await harness.session.agent.prompt("查询上海天气");

		expect(finalText(calculator.finalAssistantMessage)).toContain("161");
		expect(finalText(search.finalAssistantMessage)).toContain("19.90");
		expect(finalText(weather.finalAssistantMessage)).toContain("26");
		const completedTools = harness.traces
			.snapshot()
			.filter((event) => event.type === "tool.call.finished")
			.map((event) => ({ name: event.toolName, outcome: event.outcome }));
		expect(completedTools).toEqual([
			{ name: "calculator", outcome: "success" },
			{ name: "search", outcome: "success" },
			{ name: "weather", outcome: "success" },
		]);
		expectEveryRunAndToolCallTraced(harness.traces);
		harness.runner.assertConsumed();
	});

	it("performs search then calculator in order with cross-turn data flow", async () => {
		const harness = await createHarness([
			async () => assistant("", [call("search-price", "search", { query: "Widget-A price" })]),
			async (context) => {
				expect(toolResultText(context, "search-price")).toContain("19.90");
				return assistant("", [call("calculate-total", "calculator", { expression: "19.90 * 3" })]);
			},
			async (context) => {
				const calculation = toolResultJson(context, "calculate-total");
				expect(calculation.expression).toBe("19.90 * 3");
				expect(calculation.result).toBeCloseTo(59.7);
				return assistant("Widget-A 单价 19.90 元，3 个共 59.70 元。");
			},
		]);

		const result = await harness.session.agent.prompt("搜索 Widget-A 的单价，然后计算购买 3 个需要多少钱。", {
			runId: "run-multi-step",
		});

		expect(finalText(result.finalAssistantMessage)).toContain("59.70");
		const requestedTools = harness.traces
			.snapshot()
			.filter((event) => event.type === "tool.call.requested")
			.map((event) => event.toolName);
		expect(requestedTools).toEqual(["search", "calculator"]);
		expect(harness.traces.snapshot().every((event) => event.runId === "run-multi-step")).toBe(true);
		expectEveryRunAndToolCallTraced(harness.traces);
		harness.runner.assertConsumed();
	});

	it("supports a pure conversational follow-up from committed Session history", async () => {
		const harness = await createHarness([
			async () => assistant("记住了，项目代号是 Bluebird。"),
			async (context) => {
				const history = serializedMessages(context);
				expect(history).toContain("请记住项目代号是 Bluebird");
				expect(history).toContain("记住了，项目代号是 Bluebird");
				expect(history).toContain("项目代号是什么？");
				return assistant("项目代号是 Bluebird。");
			},
		]);

		const first = await harness.session.agent.prompt("请记住项目代号是 Bluebird");
		const followUp = await harness.session.agent.prompt("项目代号是什么？");

		expect(finalText(first.finalAssistantMessage)).toContain("Bluebird");
		expect(finalText(followUp.finalAssistantMessage)).toContain("Bluebird");
		expect(harness.traces.snapshot().filter((event) => event.type === "agent.run.finished")).toHaveLength(2);
		expectEveryRunAndToolCallTraced(harness.traces);
		harness.runner.assertConsumed();
	});

	it("reuses a persisted historical tool result in a later prompt", async () => {
		const harness = await createHarness([
			async () => assistant("", [call("search-history", "search", { query: "Widget-A price" })]),
			async () => assistant("The unit price is 19.90 yuan."),
			async (context) => {
				const history = serializedMessages(context);
				expect(history).toContain("19.90");
				expect(history).toContain("那买 5 个多少钱？");
				return assistant("", [call("calc-history", "calculator", { expression: "19.90 * 5" })]);
			},
			async (context) => {
				expect(toolResultJson(context, "calc-history")).toMatchObject({
					expression: "19.90 * 5",
					result: 99.5,
				});
				return assistant("5 个共 99.50 元。");
			},
		]);

		await harness.session.agent.prompt("查询 Widget-A 单价");
		const followUp = await harness.session.agent.prompt("那买 5 个多少钱？");

		expect(finalText(followUp.finalAssistantMessage)).toContain("99.50");
		expect(harness.runner.requests[2].messages.some((message) => message.role === "toolResult")).toBe(true);
		expectEveryRunAndToolCallTraced(harness.traces);
		harness.runner.assertConsumed();
	});

	it("keeps concurrent Session histories and traces isolated", async () => {
		const sessionA = await createHarness(
			[
				async () => assistant("Remembered ALPHA-7391."),
				async (context) => {
					const history = serializedMessages(context);
					expect(history).toContain("ALPHA-7391");
					expect(history).not.toContain("BETA-2846");
					return assistant("Your code is ALPHA-7391.");
				},
			],
			{ id: "e2e-session-a" },
		);
		const sessionB = await createHarness(
			[
				async () => assistant("Remembered BETA-2846."),
				async (context) => {
					const history = serializedMessages(context);
					expect(history).toContain("BETA-2846");
					expect(history).not.toContain("ALPHA-7391");
					return assistant("Your code is BETA-2846.");
				},
			],
			{ id: "e2e-session-b" },
		);

		await Promise.all([
			sessionA.session.agent.prompt("Remember ALPHA-7391"),
			sessionB.session.agent.prompt("Remember BETA-2846"),
		]);
		const [resultA, resultB] = await Promise.all([
			sessionA.session.agent.prompt("What is my code?"),
			sessionB.session.agent.prompt("What is my code?"),
		]);

		expect(finalText(resultA.finalAssistantMessage)).toContain("ALPHA-7391");
		expect(finalText(resultB.finalAssistantMessage)).toContain("BETA-2846");
		expect(sessionA.traces.snapshot().every((event) => event.sessionId === "e2e-session-a")).toBe(true);
		expect(sessionB.traces.snapshot().every((event) => event.sessionId === "e2e-session-b")).toBe(true);
		expectEveryRunAndToolCallTraced(sessionA.traces);
		expectEveryRunAndToolCallTraced(sessionB.traces);
	});

	it("recalls critical facts after configured context compaction", async () => {
		let compressionCount = 0;
		const compactor: Compactor = ({ messages }) => {
			if (compressionCount > 0 || JSON.stringify(messages).length < 500) return undefined;
			compressionCount++;
			return {
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: "Conversation summary: project ORBIT-928 is owned by 小林." }],
						timestamp: Date.now(),
					},
				],
				beforeTokens: 800,
				afterTokens: 20,
			};
		};
		const harness = await createHarness(
			[
				async () => assistant("记住了。"),
				async (context) => {
					expect(serializedMessages(context)).toContain("ORBIT-928");
					return assistant("填充信息已收到。");
				},
				async (context) => {
					const compacted = serializedMessages(context);
					expect(compacted).toContain("Conversation summary");
					expect(compacted).toContain("ORBIT-928");
					expect(compacted).toContain("小林");
					return assistant("项目代号是 ORBIT-928，负责人是小林。");
				},
			],
			{ compactor },
		);

		await harness.session.agent.prompt("请记住：项目代号是 ORBIT-928，负责人是小林。");
		await harness.session.agent.prompt(`填充消息：${"无关内容".repeat(80)}`);
		const result = await harness.session.agent.prompt("项目代号和负责人分别是什么？");

		expect(compressionCount).toBe(1);
		expect(finalText(result.finalAssistantMessage)).toContain("ORBIT-928");
		expect(finalText(result.finalAssistantMessage)).toContain("小林");
		expect(JSON.stringify(harness.runner.requests[2].messages)).not.toContain("请记住：");
		expectEveryRunAndToolCallTraced(harness.traces);
		harness.runner.assertConsumed();
	});

	it("returns structured tool errors to the model and recovers without crashing", async () => {
		const harness = await createHarness([
			async () => assistant("", [call("missing-tool", "unknown_tool", {})]),
			async (context) => {
				const result = context.messages.at(-1);
				expect(result).toMatchObject({ role: "toolResult", toolCallId: "missing-tool", isError: true });
				expect(JSON.stringify(result)).toContain("Tool not found");
				return assistant("", [call("invalid-args", "calculator", {})]);
			},
			async (context) => {
				const result = context.messages.at(-1);
				expect(result).toMatchObject({ role: "toolResult", toolCallId: "invalid-args", isError: true });
				return assistant("", [call("valid-call", "calculator", { expression: "6 * 7" })]);
			},
			async (context) => {
				expect(toolResultJson(context, "valid-call")).toMatchObject({ expression: "6 * 7", result: 42 });
				return assistant("结果是 42。");
			},
		]);

		const result = await harness.session.agent.prompt("计算 6 * 7");

		expect(finalText(result.finalAssistantMessage)).toContain("42");
		const outcomes = harness.traces
			.snapshot()
			.filter((event) => event.type === "tool.call.finished")
			.map((event) => ({ outcome: event.outcome, stage: event.failureStage }));
		expect(outcomes).toEqual([
			{ outcome: "error", stage: "lookup" },
			{ outcome: "error", stage: "validation" },
			{ outcome: "success", stage: undefined },
		]);
		expectEveryRunAndToolCallTraced(harness.traces);
		harness.runner.assertConsumed();
	});

	it("stops an infinite tool loop at the exact configured model-turn limit", async () => {
		const repeatCall = async () => assistant("", [call(crypto.randomUUID(), "calculator", { expression: "1 + 1" })]);
		const harness = await createHarness([repeatCall, repeatCall, repeatCall], { maxTurns: 3 });

		await expect(harness.session.agent.prompt("keep going", { runId: "run-limit" })).rejects.toMatchObject({
			name: AgentTurnLimitError.name,
			maxTurns: 3,
			turnCount: 3,
		});

		expect(harness.runner.requests).toHaveLength(3);
		expect(
			harness.traces.snapshot().filter(
				(event) => event.type === "tool.call.finished" && event.outcome === "success",
			),
		).toHaveLength(3);
		expect(harness.traces.snapshot().at(-1)).toMatchObject({
			type: "agent.run.finished",
			outcome: "error",
			toolCallCount: 3,
			error: { name: "AgentTurnLimitError" },
		});
		expectEveryRunAndToolCallTraced(harness.traces);
		harness.runner.assertConsumed();
	});
});
