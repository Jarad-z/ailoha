import { Type } from "@earendil-works/pi-ai";
import type { AssistantMessage, ToolCall, Usage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	Agent,
	AgentInputError,
	AgentStateError,
	AgentTurnLimitError,
	DefaultContextManager,
	MessageAdmissionError,
	ToolManager,
	createAbortError,
} from "../src/index.js";
import type {
	AgentContext,
	AgentInputMessage,
	AgentMessage,
	AgentModel,
	AgentTool,
	CompactorInput,
	ContextManager,
	ModelRunner,
	ToolExecutionResult,
} from "../src/index.js";

const NOW = 1_789_123_456_000;

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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

interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

const user = (content: string): AgentInputMessage => ({ role: "user", content, timestamp: NOW });

const assistant = (text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({
	role: "assistant",
	content: text ? [{ type: "text", text }] : [],
	api: MODEL.api,
	provider: MODEL.provider,
	model: MODEL.id,
	usage: ZERO_USAGE,
	stopReason,
	timestamp: NOW,
});

const call = (id: string, name = "echo", args: Record<string, unknown> = { text: id }): ToolCall => ({
	type: "toolCall",
	id,
	name,
	arguments: args,
});

const toolAssistant = (calls: readonly ToolCall[]): AssistantMessage => ({
	...assistant("", "toolUse"),
	content: [...calls],
});

type RunnerStep = (context: AgentContext, signal: AbortSignal) => AssistantMessage | Promise<AssistantMessage>;

class ScriptedRunner implements ModelRunner {
	readonly contexts: AgentContext[] = [];
	readonly snapshots: AgentMessage[][] = [];
	readonly #steps: RunnerStep[];

	constructor(steps: RunnerStep[]) {
		this.#steps = [...steps];
	}

	async run(context: AgentContext, options: { readonly signal: AbortSignal }): Promise<AssistantMessage> {
		this.contexts.push(context);
		this.snapshots.push([...context.messages]);
		const step = this.#steps.shift();
		if (!step) throw new Error("Unexpected model call.");
		return await step(context, options.signal);
	}
}

function createEchoTool(
	execute?: (toolCall: ToolCall, signal: AbortSignal) => ToolExecutionResult | Promise<ToolExecutionResult>,
): AgentTool {
	return {
		name: "echo",
		description: "Echo text",
		parameters: Type.Object({ text: Type.String() }, { additionalProperties: false }),
		async execute(toolCall, context) {
			return execute ? await execute(toolCall, context.signal) : { content: String(toolCall.arguments.text) };
		},
	};
}

function registerEcho(
	manager: ToolManager,
	execute?: (toolCall: ToolCall, signal: AbortSignal) => ToolExecutionResult | Promise<ToolExecutionResult>,
): void {
	manager.register("echo", () => createEchoTool(execute));
}

async function createAgent(
	runner: ModelRunner,
	contextManager: ContextManager = new DefaultContextManager(),
	toolManager = new ToolManager(),
	toolRequests: readonly { readonly name: string }[] = [],
): Promise<Agent> {
	await toolManager.initialize(toolRequests, {
		sessionId: "agent-test-session",
		model: MODEL,
		signal: new AbortController().signal,
	});
	return new Agent({
		sessionId: "agent-test-session",
		model: MODEL,
		modelRunner: runner,
		contextManager,
		toolManager,
	});
}

class CallbackContextManager extends DefaultContextManager {
	onAppend?: (messages: readonly AgentMessage[]) => void;

	override append(context: AgentContext, messages: AgentMessage | readonly AgentMessage[]): void {
		super.append(context, messages);
		this.onAppend?.(Array.isArray(messages) ? messages : [messages]);
	}
}

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Agent Core minimal spec", () => {
	it("1. completes a normal prompt with one model call", async () => {
		const runner = new ScriptedRunner([async () => assistant("hello")]);
		const agent = await createAgent(runner);
		const result = await agent.prompt("hi");

		expect(result.messages).toEqual([user("hi"), assistant("hello")]);
		expect(runner.contexts).toHaveLength(1);
		expect(agent.state.status).toBe("idle");
	});

	it("2. runs model, tool, then model", async () => {
		const runner = new ScriptedRunner([async () => toolAssistant([call("one")]), async () => assistant("done")]);
		const tools = new ToolManager();
		registerEcho(tools, async () => ({ content: "tool output" }));
		const agent = await createAgent(runner, new DefaultContextManager(), tools, [{ name: "echo" }]);
		const result = await agent.prompt("run");

		expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		expect(runner.contexts).toHaveLength(2);
	});

	it("3. executes multiple tool calls serially in output order", async () => {
		const execution: string[] = [];
		const runner = new ScriptedRunner([
			async () => toolAssistant([call("a"), call("b")]),
			async () => assistant("done"),
		]);
		const tools = new ToolManager();
		registerEcho(tools, async (toolCall) => {
			execution.push(toolCall.id);
			return { content: toolCall.id };
		});
		const agent = await createAgent(runner, new DefaultContextManager(), tools, [{ name: "echo" }]);
		const result = await agent.prompt("run");

		expect(execution).toEqual(["a", "b"]);
		expect(result.messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId)).toEqual([
			"a",
			"b",
		]);
	});

	it("4. injects steer after the active tool result", async () => {
		const started = deferred<void>();
		const release = deferred<void>();
		const runner = new ScriptedRunner([
			async () => toolAssistant([call("one")]),
			async () => assistant("steered"),
		]);
		const tools = new ToolManager();
		registerEcho(tools, async () => {
			started.resolve();
			await release.promise;
			return { content: "tool output" };
		});
		const contextManager = new DefaultContextManager();
		const agent = await createAgent(runner, contextManager, tools, [{ name: "echo" }]);

		const running = agent.prompt("run");
		await started.promise;
		agent.steer(user("change"));
		release.resolve();
		await running;

		expect(contextManager.snapshot().messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"user",
			"assistant",
		]);
	});

	it("5. continues the inner loop when steer exists without tool calls", async () => {
		const first = deferred<AssistantMessage>();
		const runner = new ScriptedRunner([async () => await first.promise, async () => assistant("after steer")]);
		const agent = await createAgent(runner);

		const running = agent.prompt("run");
		agent.steer(user("steer"));
		first.resolve(assistant("first"));
		const result = await running;

		expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
	});

	it("6. injects follow-up after the inner loop converges", async () => {
		let agent!: Agent;
		const runner = new ScriptedRunner([
			async () => {
				agent.followUp(user("next"));
				return assistant("first");
			},
			async () => assistant("second"),
		]);
		agent = await createAgent(runner);
		const result = await agent.prompt("start");

		expect(result.messages).toEqual([user("start"), assistant("first"), user("next"), assistant("second")]);
	});

	it("7. consumes multiple follow-up batches", async () => {
		let agent!: Agent;
		const runner = new ScriptedRunner([
			async () => {
				agent.followUp(user("batch 1"));
				return assistant("first");
			},
			async () => {
				agent.followUp(user("batch 2"));
				return assistant("second");
			},
			async () => assistant("third"),
		]);
		agent = await createAgent(runner);
		const result = await agent.prompt("start");

		expect(result.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
			"user",
			"assistant",
		]);
	});

	it("8. compacts before each iteration but not before recovery retry", async () => {
		const reasons: string[] = [];
		const contextManager = new DefaultContextManager({
			compactor: async ({ reason, messages }) => {
				reasons.push(reason);
				return reason === "llm_error" ? { messages } : undefined;
			},
		});
		const runner = new ScriptedRunner([
			async () => {
				throw new Error("overflow");
			},
			async () => toolAssistant([call("one")]),
			async () => assistant("done"),
		]);
		const tools = new ToolManager();
		registerEcho(tools);
		await (await createAgent(runner, contextManager, tools, [{ name: "echo" }])).prompt("run");

		expect(reasons).toEqual(["before_llm", "llm_error", "before_llm"]);
	});

	it("9. retries once when recovery compact changes context", async () => {
		const contextManager = new DefaultContextManager({
			compactor: async ({ reason }) => (reason === "llm_error" ? { messages: [user("summary")] } : undefined),
		});
		const runner = new ScriptedRunner([
			async () => {
				throw new Error("too long");
			},
			async (context) => {
				expect(context.messages).toEqual([user("summary")]);
				return assistant("recovered");
			},
		]);

		await expect((await createAgent(runner, contextManager)).prompt("run")).resolves.toMatchObject({
			finalAssistantMessage: { stopReason: "stop" },
		});
		expect(runner.contexts).toHaveLength(2);
	});

	it("10. propagates model error when recovery compact is unchanged", async () => {
		const reasons: string[] = [];
		const contextManager = new DefaultContextManager({
			compactor: async ({ reason }) => {
				reasons.push(reason);
				return undefined;
			},
		});
		const runner = new ScriptedRunner([
			async () => {
				throw new Error("provider failed");
			},
		]);

		await expect((await createAgent(runner, contextManager)).prompt("run")).rejects.toThrow("provider failed");
		expect(reasons).toEqual(["before_llm", "llm_error"]);
	});

	it("11. does not compact or call model a third time after retry failure", async () => {
		const reasons: string[] = [];
		const contextManager = new DefaultContextManager({
			compactor: async ({ reason, messages }) => {
				reasons.push(reason);
				return reason === "llm_error" ? { messages } : undefined;
			},
		});
		const runner = new ScriptedRunner([
			async () => {
				throw new Error("first");
			},
			async () => {
				throw new Error("second");
			},
		]);

		await expect((await createAgent(runner, contextManager)).prompt("run")).rejects.toThrow("second");
		expect(runner.contexts).toHaveLength(2);
		expect(reasons).toEqual(["before_llm", "llm_error"]);
	});

	it("12. abort bypasses recovery compact and returns to idle", async () => {
		const response = deferred<AssistantMessage>();
		const started = deferred<void>();
		const compact = vi.fn(async (_input: CompactorInput) => undefined);
		const runner = new ScriptedRunner([
			async () => {
				started.resolve();
				return await response.promise;
			},
		]);
		const agent = await createAgent(runner, new DefaultContextManager({ compactor: compact }));

		const running = agent.prompt("run");
		await started.promise;
		agent.abort();
		response.resolve(assistant("ignored"));

		await expect(running).rejects.toMatchObject({ name: "AbortError" });
		expect(compact.mock.calls.map(([input]) => input.reason)).toEqual(["before_llm"]);
		expect(agent.state.status).toBe("idle");
	});

	it("13. rejects a second prompt while active", async () => {
		const response = deferred<AssistantMessage>();
		const agent = await createAgent(new ScriptedRunner([async () => await response.promise]));
		const running = agent.prompt("first");

		await expect(agent.prompt("second")).rejects.toBeInstanceOf(AgentStateError);
		response.resolve(assistant("done"));
		await running;
	});

	it("14. keeps assistant, all tool results, then steer in history order", async () => {
		const runner = new ScriptedRunner([
			async () => toolAssistant([call("a"), call("b")]),
			async () => assistant("done"),
		]);
		const tools = new ToolManager();
		let agent!: Agent;
		let executions = 0;
		registerEcho(tools, async (toolCall) => {
			executions++;
			if (executions === 1) agent.steer(user("redirect"));
			return { content: toolCall.id };
		});
		const contextManager = new DefaultContextManager();
		agent = await createAgent(runner, contextManager, tools, [{ name: "echo" }]);
		await agent.prompt("run");

		expect(contextManager.snapshot().messages.slice(1, 5).map((message) => message.role)).toEqual([
			"assistant",
			"toolResult",
			"toolResult",
			"user",
		]);
	});

	it("15. keeps prompts and history out of Agent state", async () => {
		const agent = await createAgent(new ScriptedRunner([]));
		expect(Object.keys(agent.state).sort()).toEqual(["model", "status"]);
		expect("messages" in agent.state).toBe(false);
		expect("systemPrompt" in agent.state).toBe(false);
	});

	it("16. passes Context Manager system prompt to every model call", async () => {
		const contextManager = new DefaultContextManager({ systemPrompts: ["one", "two"] });
		const runner = new ScriptedRunner([
			async (context) => {
				expect(context.systemPrompt).toBe("one\n\ntwo");
				return toolAssistant([call("one")]);
			},
			async (context) => {
				expect(context.systemPrompt).toBe("one\n\ntwo");
				return assistant("done");
			},
		]);
		const tools = new ToolManager();
		registerEcho(tools);
		await (await createAgent(runner, contextManager, tools, [{ name: "echo" }])).prompt("run");
	});

	it("17. replaces snapshot and run-local history together during compact", async () => {
		const contextManager = new DefaultContextManager({
			messages: [user("old")],
			compactor: async ({ reason }) => (reason === "before_llm" ? { messages: [user("summary")] } : undefined),
		});
		const runner = new ScriptedRunner([
			async (context) => {
				expect(context.messages).toEqual([user("summary")]);
				expect(contextManager.snapshot().messages).toBe(context.messages);
				return assistant("done");
			},
		]);
		await (await createAgent(runner, contextManager)).prompt("new");

		expect(contextManager.snapshot().messages).toEqual([user("summary"), assistant("done")]);
	});

	it("18. cancels current and remaining tools when aborted before execution", async () => {
		const contextManager = new CallbackContextManager();
		const tools = new ToolManager();
		const execute = vi.fn(async () => ({ content: "should not run" }));
		registerEcho(tools, execute);
		const runner = new ScriptedRunner([async () => toolAssistant([call("a"), call("b")])]);
		let agent!: Agent;
		contextManager.onAppend = (messages) => {
			if (messages.some((message) => message.role === "assistant")) agent.abort();
		};
		agent = await createAgent(runner, contextManager, tools, [{ name: "echo" }]);

		await expect(agent.prompt("run")).rejects.toMatchObject({ name: "AbortError" });
		const results = contextManager.snapshot().messages.filter((message) => message.role === "toolResult");
		expect(execute).not.toHaveBeenCalled();
		expect(results).toHaveLength(2);
		expect(results[0].content[0]).toMatchObject({ type: "text", text: expect.stringContaining("cancelled") });
		expect(results[1].content[0]).toMatchObject({ type: "text", text: expect.stringContaining("skipped") });
	});

	it("19. ignores normal tool result produced after abort and closes pending calls", async () => {
		const started = deferred<void>();
		const release = deferred<void>();
		const tools = new ToolManager();
		registerEcho(tools, async () => {
			started.resolve();
			await release.promise;
			return { content: "late success" };
		});
		const contextManager = new DefaultContextManager();
		const runner = new ScriptedRunner([async () => toolAssistant([call("a"), call("b")])]);
		const agent = await createAgent(runner, contextManager, tools, [{ name: "echo" }]);

		const running = agent.prompt("run");
		await started.promise;
		agent.abort();
		release.resolve();
		await expect(running).rejects.toMatchObject({ name: "AbortError" });

		const results = contextManager.snapshot().messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(2);
		expect(results.flatMap((message) => message.content).some((block) => block.type === "text" && block.text === "late success")).toBe(
			false,
		);
	});

	it("20. treats tool AbortError as cancellation and skips remaining calls", async () => {
		let executions = 0;
		const tools = new ToolManager();
		registerEcho(tools, async () => {
			executions++;
			throw createAbortError("tool stopped");
		});
		const contextManager = new DefaultContextManager();
		const runner = new ScriptedRunner([async () => toolAssistant([call("a"), call("b")])]);
		const agent = await createAgent(runner, contextManager, tools, [{ name: "echo" }]);

		await expect(agent.prompt("run")).rejects.toMatchObject({ name: "AbortError" });
		expect(executions).toBe(1);
		expect(contextManager.snapshot().messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
	});

	it("21. rejects non-user input at all public message entries", async () => {
		const invalid = assistant("bad") as unknown as AgentInputMessage;
		const agent = await createAgent(new ScriptedRunner([async () => assistant("done")]));

		await expect(agent.prompt(invalid)).rejects.toBeInstanceOf(AgentInputError);
		expect(agent.state.status).toBe("idle");

		const running = agent.prompt("valid");
		expect(() => agent.steer(invalid)).toThrow(AgentInputError);
		expect(() => agent.followUp(invalid)).toThrow(AgentInputError);
		const result = await running;
		expect(result.messages).toEqual([user("valid"), assistant("done")]);
	});

	it("22. synchronously rejects steer in follow_up phase", async () => {
		const contextManager = new CallbackContextManager();
		let agent!: Agent;
		let observed: Error | undefined;
		contextManager.onAppend = (messages) => {
			if (!messages.some((message) => message.role === "assistant")) return;
			queueMicrotask(() => {
				queueMicrotask(() => {
					try {
						agent.steer(user("too late"));
					} catch (error) {
						observed = error as Error;
					}
				});
			});
		};
		agent = await createAgent(new ScriptedRunner([async () => assistant("done")]), contextManager);
		const result = await agent.prompt("run");

		expect(observed).toBeInstanceOf(MessageAdmissionError);
		expect(result.messages.some((message) => message.role === "user" && message.content === "too late")).toBe(false);
	});

	it("23. synchronously rejects follow-up in closing phase", async () => {
		let agent!: Agent;
		let observed: Error | undefined;
		let armed = false;
		const stored: AgentMessage[] = [];
		const contextManager: ContextManager = {
			maxTurns: Number.POSITIVE_INFINITY,
			turnCount: 0,
			consumeTurn() {},
			async beginRun(request) {
				stored.push(...request.promptMessages);
				return {
					systemPrompt: "",
					tools: request.tools,
					get messages() {
						if (armed) {
							armed = false;
							try {
								agent.followUp(user("too late"));
							} catch (error) {
								observed = error as Error;
							}
						}
						return stored;
					},
				};
			},
			append(_context, messages) {
				const batch = Array.isArray(messages) ? messages : [messages];
				stored.push(...batch);
				if (batch.some((message) => message.role === "assistant")) armed = true;
			},
			async compact() {
				return { changed: false };
			},
			async compactCurrent() {
				return { changed: false };
			},
			snapshot() {
				return { systemPrompts: [], messages: stored };
			},
		};
		agent = await createAgent(new ScriptedRunner([async () => assistant("done")]), contextManager);
		const result = await agent.prompt("run");

		expect(observed).toBeInstanceOf(MessageAdmissionError);
		expect(result.messages.some((message) => message.role === "user" && message.content === "too late")).toBe(false);
	});

	it("24. does not commit model response resolved after abort", async () => {
		const response = deferred<AssistantMessage>();
		const started = deferred<void>();
		const runner = new ScriptedRunner([
			async () => {
				started.resolve();
				return await response.promise;
			},
		]);
		const contextManager = new DefaultContextManager();
		const agent = await createAgent(runner, contextManager);

		const running = agent.prompt("run");
		await started.promise;
		agent.abort();
		response.resolve(assistant("late"));

		await expect(running).rejects.toMatchObject({ name: "AbortError" });
		expect(contextManager.snapshot().messages).toEqual([user("run")]);
	});

	it("25. skips recovery compact when abort wins over provider error", async () => {
		const response = deferred<AssistantMessage>();
		const started = deferred<void>();
		const compact = vi.fn(async (_input: CompactorInput) => undefined);
		const runner = new ScriptedRunner([
			async () => {
				started.resolve();
				return await response.promise;
			},
		]);
		const agent = await createAgent(runner, new DefaultContextManager({ compactor: compact }));

		const running = agent.prompt("run");
		await started.promise;
		agent.abort();
		response.reject(new Error("provider failure"));

		await expect(running).rejects.toMatchObject({ name: "AbortError" });
		expect(compact.mock.calls.map(([input]) => input.reason)).toEqual(["before_llm"]);
	});

	it("26. does not commit compact output resolved after abort or call model", async () => {
		const started = deferred<void>();
		const result = deferred<{ messages: AgentMessage[] }>();
		const contextManager = new DefaultContextManager({
			compactor: async () => {
				started.resolve();
				return await result.promise;
			},
		});
		const runner = new ScriptedRunner([async () => assistant("never")]);
		const agent = await createAgent(runner, contextManager);

		const running = agent.prompt("run");
		await started.promise;
		agent.abort();
		result.resolve({ messages: [user("compacted")] });

		await expect(running).rejects.toMatchObject({ name: "AbortError" });
		expect(contextManager.snapshot().messages).toEqual([user("run")]);
		expect(runner.contexts).toHaveLength(0);
	});

	it("27. leaves history unchanged after ignored abort during beginRun prepare", async () => {
		const started = deferred<void>();
		const done = deferred<void>();
		const contextManager = new DefaultContextManager({
			messages: [user("existing")],
			prepareRun: async () => {
				started.resolve();
				await done.promise;
			},
		});
		const runner = new ScriptedRunner([async () => assistant("never")]);
		const agent = await createAgent(runner, contextManager);

		const running = agent.prompt("new");
		await started.promise;
		agent.abort();
		done.resolve();

		await expect(running).rejects.toMatchObject({ name: "AbortError" });
		expect(contextManager.snapshot().messages).toEqual([user("existing")]);
		expect(runner.contexts).toHaveLength(0);
	});

	it("28. clears queued messages after failure so they cannot leak", async () => {
		const first = deferred<AssistantMessage>();
		const runner = new ScriptedRunner([async () => await first.promise, async () => assistant("second result")]);
		const agent = await createAgent(runner);

		const failed = agent.prompt("first");
		agent.steer(user("stale steer"));
		agent.followUp(user("stale follow-up"));
		first.reject(new Error("failed"));
		await expect(failed).rejects.toThrow("failed");
		const result = await agent.prompt("second");

		expect(result.messages.some((message) => message.role === "user" && message.content === "stale steer")).toBe(false);
		expect(result.messages.some((message) => message.role === "user" && message.content === "stale follow-up")).toBe(false);
	});

	it("29. leaves committed state unchanged when beginRun prepare throws", async () => {
		const contextManager = new DefaultContextManager({
			messages: [user("existing")],
			prepareRun: async () => {
				throw new Error("prepare failed");
			},
		});
		const agent = await createAgent(new ScriptedRunner([]), contextManager);

		await expect(agent.prompt("new")).rejects.toThrow("prepare failed");
		expect(contextManager.snapshot().messages).toEqual([user("existing")]);
	});

	it("30. exposes neither prompt history nor run context before beginRun commit", async () => {
		const started = deferred<void>();
		const release = deferred<void>();
		const contextManager = new DefaultContextManager({
			messages: [user("existing")],
			prepareRun: async () => {
				started.resolve();
				await release.promise;
			},
		});
		const runner = new ScriptedRunner([
			async (context) => {
				expect(context.messages).toEqual([user("existing"), user("new")]);
				expect(contextManager.snapshot().messages).toBe(context.messages);
				return assistant("done");
			},
		]);
		const agent = await createAgent(runner, contextManager);

		const running = agent.prompt("new");
		await started.promise;
		expect(contextManager.snapshot().messages).toEqual([user("existing")]);
		expect(runner.contexts).toHaveLength(0);
		release.resolve();
		await running;
	});

	it("31. converts resolved model error before append and applies recovery", async () => {
		const reasons: string[] = [];
		const contextManager = new DefaultContextManager({
			compactor: async ({ reason, messages }) => {
				reasons.push(reason);
				return reason === "llm_error" ? { messages } : undefined;
			},
		});
		const failed = { ...assistant("must not persist", "error"), errorMessage: "resolved failure" };
		const runner = new ScriptedRunner([async () => failed, async () => assistant("recovered")]);
		await (await createAgent(runner, contextManager)).prompt("run");

		expect(reasons).toEqual(["before_llm", "llm_error"]);
		expect(contextManager.snapshot().messages).not.toContain(failed);
	});

	it("32. converts resolved aborted status without append or recovery", async () => {
		const reasons: string[] = [];
		const contextManager = new DefaultContextManager({
			compactor: async ({ reason }) => {
				reasons.push(reason);
				return undefined;
			},
		});
		const aborted = { ...assistant("must not persist", "aborted"), errorMessage: "provider aborted" };
		const agent = await createAgent(new ScriptedRunner([async () => aborted]), contextManager);

		await expect(agent.prompt("run")).rejects.toMatchObject({ name: "AbortError" });
		expect(reasons).toEqual(["before_llm"]);
		expect(contextManager.snapshot().messages).not.toContain(aborted);
	});

	it("converts missing tools, invalid arguments, and execution failures to results", async () => {
		const runner = new ScriptedRunner([
			async () =>
				toolAssistant([call("missing", "missing"), call("invalid", "echo", { text: 1 }), call("failure")]),
			async () => assistant("done"),
		]);
		const tools = new ToolManager();
		registerEcho(tools, async () => {
			throw new Error("tool failed");
		});
		const result = await (await createAgent(runner, new DefaultContextManager(), tools, [{ name: "echo" }])).prompt("run");
		const errors = result.messages.filter((message) => message.role === "toolResult");

		expect(errors).toHaveLength(3);
		expect(errors.every((message) => message.isError)).toBe(true);
		expect(errors.map((message) => message.content[0])).toMatchObject([
			{ text: "Tool not found: missing" },
			{ text: "arguments.text must be of type string." },
			{ text: "tool failed" },
		]);
	});

	it("reuses initialized tools across top-level prompts", async () => {
		let factoryCalls = 0;
		const tools = new ToolManager();
		tools.register("echo", () => {
			factoryCalls++;
			return createEchoTool();
		});
		const agent = await createAgent(
			new ScriptedRunner([async () => assistant("one"), async () => assistant("two")]),
			new DefaultContextManager(),
			tools,
			[{ name: "echo" }],
		);
		await agent.prompt("first");
		await agent.prompt("second");
		expect(factoryCalls).toBe(1);
		expect(tools.status).toBe("ready");
	});

	it("waitForIdle resolves after success, failure, and cancellation", async () => {
		const success = await createAgent(new ScriptedRunner([async () => assistant("done")]));
		const successRun = success.prompt("run");
		await success.waitForIdle();
		await successRun;

		const failure = await createAgent(
			new ScriptedRunner([
				async () => {
					throw new Error("failed");
				},
			]),
		);
		await expect(failure.prompt("run")).rejects.toThrow("failed");
		await expect(failure.waitForIdle()).resolves.toBeUndefined();

		const pending = deferred<AssistantMessage>();
		const cancelled = await createAgent(new ScriptedRunner([async () => await pending.promise]));
		const cancelledRun = cancelled.prompt("run");
		cancelled.abort();
		pending.resolve(assistant("late"));
		await expect(cancelledRun).rejects.toMatchObject({ name: "AbortError" });
		await expect(cancelled.waitForIdle()).resolves.toBeUndefined();
	});

	it("enforces a ContextManager turn limit across top-level prompts", async () => {
		const contextManager = new DefaultContextManager({ maxTurns: 1 });
		const runner = new ScriptedRunner([async () => assistant("first")]);
		const agent = await createAgent(runner, contextManager);

		await expect(agent.prompt("one")).resolves.toMatchObject({
			finalAssistantMessage: { content: [{ text: "first" }] },
		});
		expect(contextManager.turnCount).toBe(1);
		await expect(agent.prompt("two")).rejects.toMatchObject({
			name: "AgentTurnLimitError",
			maxTurns: 1,
			turnCount: 1,
		});
		expect(runner.contexts).toHaveLength(1);
		expect(contextManager.snapshot().messages).toEqual([user("one"), assistant("first")]);
		expect(agent.state.status).toBe("idle");
	});

	it("rejects steer and follow-up once the final turn is reserved", async () => {
		const started = deferred<void>();
		const response = deferred<AssistantMessage>();
		const contextManager = new DefaultContextManager({ maxTurns: 1 });
		const runner = new ScriptedRunner([
			async () => {
				started.resolve();
				return await response.promise;
			},
		]);
		const agent = await createAgent(runner, contextManager);

		const running = agent.prompt("run");
		await started.promise;
		expect(() => agent.steer(user("late steer"))).toThrow(AgentTurnLimitError);
		expect(() => agent.followUp(user("late follow-up"))).toThrow(AgentTurnLimitError);
		response.resolve(assistant("done"));
		const result = await running;

		expect(result.messages).toEqual([user("run"), assistant("done")]);
	});

	it("stops a tool loop before a model call beyond maxTurns", async () => {
		const contextManager = new DefaultContextManager({ maxTurns: 1 });
		const runner = new ScriptedRunner([
			async () => toolAssistant([call("one")]),
			async () => assistant("must not run"),
		]);
		const tools = new ToolManager();
		registerEcho(tools);
		const agent = await createAgent(runner, contextManager, tools, [{ name: "echo" }]);

		await expect(agent.prompt("run")).rejects.toBeInstanceOf(AgentTurnLimitError);
		expect(runner.contexts).toHaveLength(1);
		expect(contextManager.turnCount).toBe(1);
		expect(contextManager.snapshot().messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
		]);
	});

	it("counts failed model attempts and does not bypass maxTurns during compact recovery", async () => {
		const contextManager = new DefaultContextManager({
			maxTurns: 1,
			compactor: async ({ reason }) =>
				reason === "llm_error" ? { messages: [user("summary")] } : undefined,
		});
		const runner = new ScriptedRunner([
			async () => {
				throw new Error("overflow");
			},
			async () => assistant("must not retry"),
		]);
		const agent = await createAgent(runner, contextManager);

		await expect(agent.prompt("run")).rejects.toBeInstanceOf(AgentTurnLimitError);
		expect(runner.contexts).toHaveLength(1);
		expect(contextManager.turnCount).toBe(1);
	});

	it("validates maxTurns", () => {
		expect(() => new DefaultContextManager({ maxTurns: -1 })).toThrow(RangeError);
		expect(() => new DefaultContextManager({ maxTurns: 1.5 })).toThrow(RangeError);
		expect(new DefaultContextManager({ maxTurns: Number.POSITIVE_INFINITY }).maxTurns).toBe(
			Number.POSITIVE_INFINITY,
		);
	});
});
