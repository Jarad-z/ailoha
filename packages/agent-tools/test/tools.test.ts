import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AssistantMessage, ToolCall, Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	Agent,
	DefaultContextManager,
	Session,
	ToolManager,
	validateJsonSchema,
} from "@ailoha/agent-core";
import type {
	AgentContext,
	AgentModel,
	AgentTool,
	ToolExecutionContext,
	ToolExecutionResult,
} from "@ailoha/agent-core";
import {
	calculate,
	createCalculatorTool,
	createMockSearchProvider,
	createReadDocsTool,
	createSearchTool,
	createTodoTool,
	createWeatherTool,
	registerAgentTools,
} from "../src/index.js";

const MODEL: AgentModel = {
	id: "fake-model",
	name: "Fake Model",
	api: "test-api",
	provider: "test-provider",
	baseUrl: "https://invalid.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_000,
};

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const abortController = new AbortController();
const AGENT_CONTEXT: AgentContext = { systemPrompt: "", messages: [], tools: [] };
const EXECUTION_CONTEXT: ToolExecutionContext = {
	sessionId: "agent-tools-test-session",
	model: MODEL,
	context: AGENT_CONTEXT,
	signal: abortController.signal,
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		if (directory.startsWith(path.resolve(tmpdir()))) await rm(directory, { recursive: true, force: true });
	}
});

function toolCall(name: string, argumentsValue: Record<string, unknown>, id = `${name}-1`): ToolCall {
	return { type: "toolCall", id, name, arguments: argumentsValue };
}

async function execute(
	tool: AgentTool,
	argumentsValue: Record<string, unknown>,
	context: ToolExecutionContext = EXECUTION_CONTEXT,
): Promise<ToolExecutionResult> {
	return await tool.execute(toolCall(tool.name, argumentsValue), context);
}

function parseContent(result: ToolExecutionResult): Record<string, unknown> {
	if (typeof result.content !== "string") throw new Error("Expected JSON string tool content.");
	return JSON.parse(result.content) as Record<string, unknown>;
}

function modelMessage(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: ZERO_USAGE,
		stopReason,
		timestamp: 1,
	};
}

describe("calculator", () => {
	it("evaluates precedence, powers, constants, and functions", () => {
		expect(calculate("2 + 3 * 4")).toBe(14);
		expect(calculate("2^3^2")).toBe(512);
		expect(calculate("-2^2")).toBe(-4);
		expect(calculate("sqrt(16) + max(2, 5) + round(pi)")).toBe(12);
	});

	it("returns errors for unsafe or invalid expressions", async () => {
		const tool = createCalculatorTool();
		const injection = await execute(tool, { expression: "process.exit()" });
		const division = await execute(tool, { expression: "1 / 0" });

		expect(injection.isError).toBe(true);
		expect(division).toMatchObject({ isError: true, content: "Division by zero." });
	});
});

describe("search", () => {
	const documents = [
		{ id: "agent", title: "Agent Core", content: "ReAct loops execute tools and process steer messages." },
		{ id: "weather", title: "Weather Tool", content: "A weather provider returns current conditions." },
		{ id: "other", title: "Other", content: "Unrelated content." },
	];

	it("ranks deterministic mock documents and respects limit", async () => {
		const result = parseContent(await execute(createSearchTool({ documents }), { query: "agent tools", limit: 1 }));
		const results = result.results as Array<{ id: string }>;

		expect(results).toHaveLength(1);
		expect(results[0].id).toBe("agent");
	});

	it("supports an injected asynchronous provider", async () => {
		const provider = createMockSearchProvider(documents);
		const tool = createSearchTool({
			provider: async (query, options) => await provider(query, options),
		});
		const result = parseContent(await execute(tool, { query: "weather" }));

		expect(result.results).toMatchObject([{ id: "weather" }]);
	});
});

describe("read_docs", () => {
	it("reads and truncates UTF-8 files under an allowed root", async () => {
		const parent = await mkdtemp(path.join(tmpdir(), "ailoha-tools-"));
		temporaryDirectories.push(parent);
		const docs = path.join(parent, "docs");
		await mkdir(docs);
		await writeFile(path.join(docs, "guide.md"), "abcdef", "utf8");
		const result = parseContent(await execute(createReadDocsTool({ roots: [docs], maxCharacters: 4 }), { path: "guide.md" }));

		expect(result).toEqual({ path: "guide.md", content: "abcd", truncated: true });
	});

	it("blocks parent traversal outside configured roots", async () => {
		const parent = await mkdtemp(path.join(tmpdir(), "ailoha-tools-"));
		temporaryDirectories.push(parent);
		const docs = path.join(parent, "docs");
		await mkdir(docs);
		await writeFile(path.join(parent, "secret.md"), "secret", "utf8");
		const result = await execute(createReadDocsTool({ roots: [docs] }), { path: "../secret.md" });

		expect(result.isError).toBe(true);
		expect(result.content).toContain("outside allowed roots");
	});
});

describe("todo", () => {
	it("supports add, list, complete, remove, and clear", async () => {
		const tool = createTodoTool({ initialItems: ["existing"] });
		const added = parseContent(await execute(tool, { action: "add", text: "write tests" }));
		const item = added.item as { id: string };
		const completed = parseContent(await execute(tool, { action: "complete", id: item.id }));
		const listed = parseContent(await execute(tool, { action: "list" }));

		expect(completed.item).toMatchObject({ id: item.id, status: "completed" });
		expect(listed.items).toHaveLength(2);
		expect(parseContent(await execute(tool, { action: "remove", id: item.id }))).toEqual({ removed: item.id });
		expect(parseContent(await execute(tool, { action: "clear" }))).toEqual({ cleared: 1 });
	});

	it("keeps default stores isolated between tool instances", async () => {
		const first = createTodoTool();
		const second = createTodoTool();
		await execute(first, { action: "add", text: "private" });

		expect(parseContent(await execute(first, { action: "list" })).items).toHaveLength(1);
		expect(parseContent(await execute(second, { action: "list" })).items).toHaveLength(0);
	});
});

describe("weather", () => {
	it("returns default mock weather and converts Fahrenheit", async () => {
		const result = parseContent(await execute(createWeatherTool(), { location: "Beijing", units: "fahrenheit" }));

		expect(result).toMatchObject({ location: "Beijing", condition: "clear", temperature: 71.6, unit: "F" });
	});

	it("supports custom readings and reports missing locations", async () => {
		const tool = createWeatherTool({ readings: [{ location: "Hangzhou", condition: "fog", temperatureC: 18 }] });
		const found = parseContent(await execute(tool, { location: "hangzhou" }));
		const missing = await execute(tool, { location: "Shanghai" });

		expect(found).toMatchObject({ location: "Hangzhou", temperature: 18, unit: "C" });
		expect(missing).toMatchObject({ isError: true, content: "No weather data for: Shanghai" });
	});

	it("declares a runtime-enforced units union", () => {
		const tool = createWeatherTool();
		expect(validateJsonSchema(tool.parameters, { location: "Beijing", units: "kelvin" }).valid).toBe(false);
		expect(validateJsonSchema(tool.parameters, { location: "Beijing", units: "celsius" }).valid).toBe(true);
	});
});

describe("registration and Agent integration", () => {
	it("registers all five tools and accepts read_docs roots from ToolRequest", async () => {
		const parent = await mkdtemp(path.join(tmpdir(), "ailoha-tools-"));
		temporaryDirectories.push(parent);
		const manager = new ToolManager();
		registerAgentTools(manager);

		await manager.initialize(
			[
				{ name: "calculator" },
				{ name: "search" },
				{ name: "read_docs", options: { roots: [parent] } },
				{ name: "todo" },
				{ name: "weather" },
			],
			{ sessionId: "agent-tools-test-session", model: MODEL, signal: new AbortController().signal },
		);
		const tools = manager.tools;

		expect(tools.map((tool) => tool.name)).toEqual(["calculator", "search", "read_docs", "todo", "weather"]);
	});

	it("executes all five tools through one Agent ReAct iteration", async () => {
		const parent = await mkdtemp(path.join(tmpdir(), "ailoha-tools-"));
		temporaryDirectories.push(parent);
		await writeFile(path.join(parent, "guide.md"), "Agent guide", "utf8");
		const manager = new ToolManager();
		registerAgentTools(manager, {
			search: { documents: [{ id: "guide", title: "Guide", content: "Agent guide" }] },
			readDocs: { roots: [parent] },
			weather: { readings: [{ location: "Hangzhou", condition: "clear", temperatureC: 20 }] },
		});
		await manager.initialize(
			["calculator", "search", "read_docs", "todo", "weather"].map((name) => ({ name })),
			{ sessionId: "agent-tools-test-session", model: MODEL, signal: new AbortController().signal },
		);

		let modelCalls = 0;
		const modelRunner = {
			async run(context: AgentContext): Promise<AssistantMessage> {
				modelCalls++;
				if (modelCalls === 1) {
					return modelMessage(
						[
							toolCall("calculator", { expression: "6 * 7" }),
							toolCall("search", { query: "agent" }),
							toolCall("read_docs", { path: "guide.md" }),
							toolCall("todo", { action: "add", text: "ship core" }),
							toolCall("weather", { location: "Hangzhou" }),
						],
						"toolUse",
					);
				}
				const results = context.messages.filter((message) => message.role === "toolResult");
				expect(results).toHaveLength(5);
				expect(results.every((result) => !result.isError)).toBe(true);
				return modelMessage([{ type: "text", text: "done" }], "stop");
			},
		};
		const agent = new Agent({
			sessionId: "agent-tools-test-session",
			model: MODEL,
			modelRunner,
			contextManager: new DefaultContextManager(),
			toolManager: manager,
		});

		const result = await agent.prompt("Use every tool");

		expect(modelCalls).toBe(2);
		expect(result.messages.filter((message) => message.role === "toolResult")).toHaveLength(5);
	});

	it("keeps the built-in todo store across Session prompts", async () => {
		let modelCalls = 0;
		const session = await Session.create({
			model: MODEL,
			createModelRunner: () => ({
				async run(context: AgentContext): Promise<AssistantMessage> {
					modelCalls++;
					if (modelCalls === 1) {
						return modelMessage([toolCall("todo", { action: "add", text: "persist" }, "add")], "toolUse");
					}
					if (modelCalls === 2) return modelMessage([{ type: "text", text: "added" }], "stop");
					if (modelCalls === 3) {
						return modelMessage([toolCall("todo", { action: "list" }, "list")], "toolUse");
					}
					const listResult = context.messages.find(
						(message) => message.role === "toolResult" && message.toolCallId === "list",
					);
					expect(listResult?.content[0]).toMatchObject({
						text: expect.stringContaining('"text":"persist"'),
					});
					return modelMessage([{ type: "text", text: "listed" }], "stop");
				},
			}),
			configureTools: (manager) => manager.register("todo", () => createTodoTool()),
			toolRequests: [{ name: "todo" }],
		});

		await session.agent.prompt("add todo");
		await session.agent.prompt("list todo");
		expect(modelCalls).toBe(4);
		await session.dispose();
	});
});
