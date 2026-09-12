import { Type } from "@earendil-works/pi-ai";
import type { AssistantMessage, ToolCall, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { DefaultContextManager, Session, ToolManager } from "../src/index.js";
import type { AgentContext, AgentModel, AgentTool, ModelRunner, ToolExecutionResult } from "../src/index.js";

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
	id: "session-test-model",
	name: "Session Test Model",
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
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: NOW,
	};
}

function toolCall(id: string, name: string, argumentsValue: Record<string, unknown> = {}): ToolCall {
	return { type: "toolCall", id, name, arguments: argumentsValue };
}

function toolAssistant(call: ToolCall): AssistantMessage {
	return { ...assistant(""), content: [call], stopReason: "toolUse" };
}

type RunnerStep = (context: AgentContext, signal: AbortSignal) => AssistantMessage | Promise<AssistantMessage>;

class ScriptedRunner implements ModelRunner {
	readonly contexts: AgentContext[] = [];
	readonly snapshots: AgentContext["messages"][] = [];
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

function statefulTool(
	name: string,
	execute: (call: ToolCall) => ToolExecutionResult | Promise<ToolExecutionResult>,
	dispose?: () => void | Promise<void>,
): AgentTool {
	return {
		name,
		description: name,
		parameters: Type.Object(
			{
				action: Type.Optional(Type.String()),
				text: Type.Optional(Type.String()),
			},
			{ additionalProperties: false },
		),
		async execute(call) {
			return await execute(call);
		},
		dispose,
	};
}

describe("Session tool lifecycle", () => {
	it("uses one stable session ID across factories and tool execution", async () => {
		const observedIds: string[] = [];
		const runner = new ScriptedRunner([
			async () => toolAssistant(toolCall("state-call", "state")),
			async () => assistant("done"),
		]);
		const session = await Session.create(
			{
				model: MODEL,
				createModelRunner: (context) => {
					observedIds.push(context.sessionId);
					return runner;
				},
				createContextManager: (context) => {
					observedIds.push(context.sessionId);
					return new DefaultContextManager();
				},
				configureTools: (manager, context) => {
					observedIds.push(context.sessionId);
					manager.register("state", (_request, initContext) => {
						observedIds.push(initContext.sessionId);
						return {
							...statefulTool("state", () => ({ content: "ok" })),
							async execute(_call, executionContext) {
								observedIds.push(executionContext.sessionId);
								return { content: "ok" };
							},
						};
					});
				},
				toolRequests: [{ name: "state" }],
			},
			{ id: "stable-session" },
		);

		await session.agent.prompt("run");
		expect(session.sessionId).toBe("stable-session");
		expect(session.agent.sessionId).toBe("stable-session");
		expect(observedIds).toEqual(Array(5).fill("stable-session"));
		await session.dispose();
	});

	it("cancels Session creation and cleans a tool returned after abort", async () => {
		const controller = new AbortController();
		const pending = deferred<AgentTool>();
		const dispose = vi.fn();
		const creating = Session.create(
			{
				model: MODEL,
				createModelRunner: () => new ScriptedRunner([]),
				configureTools: (manager) => manager.register("state", async () => await pending.promise),
				toolRequests: [{ name: "state" }],
			},
			{ id: "cancelled-session", signal: controller.signal },
		);

		controller.abort();
		pending.resolve(statefulTool("state", () => ({ content: "late" }), dispose));

		await expect(creating).rejects.toMatchObject({ name: "AbortError" });
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("detaches the creation signal after Session becomes ready", async () => {
		const controller = new AbortController();
		const session = await Session.create(
			{
				model: MODEL,
				createModelRunner: () => new ScriptedRunner([async () => assistant("still ready")]),
			},
			{ id: "ready-session", signal: controller.signal },
		);

		controller.abort();
		await expect(session.agent.prompt("run")).resolves.toMatchObject({
			finalAssistantMessage: { content: [{ text: "still ready" }] },
		});
		await session.dispose();
	});

	it("stops between dependency factories when creation is synchronously aborted", async () => {
		const controller = new AbortController();
		const createContextManager = vi.fn(() => new DefaultContextManager());
		const creating = Session.create(
			{
				model: MODEL,
				createModelRunner: () => {
					controller.abort();
					return new ScriptedRunner([]);
				},
				createContextManager,
			},
			{ id: "sync-cancel", signal: controller.signal },
		);

		await expect(creating).rejects.toMatchObject({ name: "AbortError" });
		expect(createContextManager).not.toHaveBeenCalled();
	});

	it("rejects a ContextManager shared by two Sessions without breaking its owner", async () => {
		const sharedContext = new DefaultContextManager();
		const first = await Session.create(
			{
				model: MODEL,
				createModelRunner: () => new ScriptedRunner([async () => assistant("owner works")]),
				createContextManager: () => sharedContext,
			},
			{ id: "context-owner" },
		);

		await expect(
			Session.create(
				{
					model: MODEL,
					createModelRunner: () => new ScriptedRunner([]),
					createContextManager: () => sharedContext,
				},
				{ id: "context-borrower" },
			),
		).rejects.toThrow("ContextManager is already owned");
		await expect(first.agent.prompt("run")).resolves.toBeDefined();
		await first.dispose();
	});

	it("rejects a ToolManager shared by two Sessions without disposing its owner", async () => {
		const sharedTools = new ToolManager();
		const first = await Session.create(
			{
				model: MODEL,
				createModelRunner: () => new ScriptedRunner([async () => assistant("owner works")]),
				createToolManager: () => sharedTools,
			},
			{ id: "tools-owner" },
		);

		await expect(
			Session.create(
				{
					model: MODEL,
					createModelRunner: () => new ScriptedRunner([]),
					createToolManager: () => sharedTools,
				},
				{ id: "tools-borrower" },
			),
		).rejects.toThrow("ToolManager is already owned");
		expect(sharedTools.status).toBe("ready");
		await expect(first.agent.prompt("run")).resolves.toBeDefined();
		await first.dispose();
	});

	it("rejects a Tool object shared across Sessions without disposing its owner", async () => {
		const dispose = vi.fn();
		const sharedTool = statefulTool("state", () => ({ content: "ok" }), dispose);
		const first = await Session.create(
			{
				model: MODEL,
				createModelRunner: () => new ScriptedRunner([async () => assistant("owner works")]),
				configureTools: (manager) => manager.register("state", () => sharedTool),
				toolRequests: [{ name: "state" }],
			},
			{ id: "tool-owner" },
		);

		await expect(
			Session.create(
				{
					model: MODEL,
					createModelRunner: () => new ScriptedRunner([]),
					configureTools: (manager) => manager.register("state", () => sharedTool),
					toolRequests: [{ name: "state" }],
				},
				{ id: "tool-borrower" },
			),
		).rejects.toThrow("Tool instance state is already owned");
		expect(dispose).not.toHaveBeenCalled();
		await expect(first.agent.prompt("run")).resolves.toBeDefined();
		await first.dispose();
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("creates dependencies in order and initializes each requested tool once", async () => {
		const events: string[] = [];
		const factory = vi.fn(() => {
			events.push("tool factory");
			return statefulTool("state", () => ({ content: "ok" }));
		});
		const runner = new ScriptedRunner([async () => assistant("done")]);

		const session = await Session.create({
			model: MODEL,
			createModelRunner: () => {
				events.push("model runner");
				return runner;
			},
			createContextManager: () => {
				events.push("context manager");
				return new DefaultContextManager();
			},
			createToolManager: () => {
				events.push("tool manager");
				return new ToolManager();
			},
			configureTools: (manager) => {
				events.push("configure tools");
				manager.register("state", factory);
			},
			toolRequests: [{ name: "state" }],
		});

		expect(events).toEqual(["model runner", "context manager", "tool manager", "configure tools", "tool factory"]);
		expect(factory).toHaveBeenCalledTimes(1);
		expect(session.agent).toBeDefined();
		await session.dispose();
	});

	it("reuses the same tool object across top-level prompts", async () => {
		const runner = new ScriptedRunner([async () => assistant("first"), async () => assistant("second")]);
		const factory = vi.fn(() => statefulTool("state", () => ({ content: "ok" })));
		let manager!: ToolManager;
		const session = await Session.create({
			model: MODEL,
			createModelRunner: () => runner,
			createToolManager: () => (manager = new ToolManager()),
			configureTools: (tools) => tools.register("state", factory),
			toolRequests: [{ name: "state" }],
		});

		await session.agent.prompt("first");
		await session.agent.prompt("second");

		expect(factory).toHaveBeenCalledTimes(1);
		expect(runner.contexts[0].tools).toBe(runner.contexts[1].tools);
		expect(manager.status).toBe("ready");
		await session.dispose();
	});

	it("preserves stateful todo data across top-level prompts", async () => {
		const items: string[] = [];
		const runner = new ScriptedRunner([
			async () => toolAssistant(toolCall("add", "todo", { action: "add", text: "persist me" })),
			async () => assistant("added"),
			async () => toolAssistant(toolCall("list", "todo", { action: "list" })),
			async () => assistant("listed"),
		]);
		const session = await Session.create({
			model: MODEL,
			createModelRunner: () => runner,
			configureTools: (manager) =>
				manager.register("todo", () =>
					statefulTool("todo", (call) => {
						if (call.arguments.action === "add") items.push(String(call.arguments.text));
						return { content: JSON.stringify({ items }) };
					}),
				),
			toolRequests: [{ name: "todo" }],
		});

		await session.agent.prompt("add");
		const second = await session.agent.prompt("list");
		const listResult = second.messages.filter(
			(message) => message.role === "toolResult" && message.toolCallId === "list",
		);
		expect(listResult[0].content[0]).toMatchObject({ text: JSON.stringify({ items: ["persist me"] }) });
		await session.dispose();
	});

	it("uses the same tool instance after steer", async () => {
		let session!: Session;
		let executions = 0;
		const factory = vi.fn(() =>
			statefulTool("state", () => {
				executions++;
				if (executions === 1) {
					session.agent.steer({ role: "user", content: "again", timestamp: NOW });
				}
				return { content: String(executions) };
			}),
		);
		const runner = new ScriptedRunner([
			async () => toolAssistant(toolCall("first", "state")),
			async () => toolAssistant(toolCall("second", "state")),
			async () => assistant("done"),
		]);
		session = await Session.create({
			model: MODEL,
			createModelRunner: () => runner,
			configureTools: (manager) => manager.register("state", factory),
			toolRequests: [{ name: "state" }],
		});

		await session.agent.prompt("run");
		expect(factory).toHaveBeenCalledTimes(1);
		expect(executions).toBe(2);
		await session.dispose();
	});

	it("uses the same tool instance after follow-up", async () => {
		let session!: Session;
		let executions = 0;
		const factory = vi.fn(() => statefulTool("state", () => ({ content: String(++executions) })));
		const runner = new ScriptedRunner([
			async () => toolAssistant(toolCall("first", "state")),
			async () => {
				session.agent.followUp({ role: "user", content: "again", timestamp: NOW });
				return assistant("first done");
			},
			async () => toolAssistant(toolCall("second", "state")),
			async () => assistant("second done"),
		]);
		session = await Session.create({
			model: MODEL,
			createModelRunner: () => runner,
			configureTools: (manager) => manager.register("state", factory),
			toolRequests: [{ name: "state" }],
		});

		await session.agent.prompt("run");
		expect(factory).toHaveBeenCalledTimes(1);
		expect(executions).toBe(2);
		await session.dispose();
	});

	it("keeps ToolManager ready after a run failure", async () => {
		let manager!: ToolManager;
		const runner = new ScriptedRunner([
			async () => {
				throw new Error("provider failed");
			},
		]);
		const session = await Session.create({
			model: MODEL,
			createModelRunner: () => runner,
			createToolManager: () => (manager = new ToolManager()),
		});

		await expect(session.agent.prompt("fail")).rejects.toThrow("provider failed");
		expect(manager.status).toBe("ready");
		await session.dispose();
	});

	it("keeps tools ready after run abort and reuses them on the next prompt", async () => {
		const pending = deferred<AssistantMessage>();
		const started = deferred<void>();
		const dispose = vi.fn();
		let manager!: ToolManager;
		const runner = new ScriptedRunner([
			async () => {
				started.resolve();
				return await pending.promise;
			},
			async () => assistant("next succeeded"),
		]);
		const session = await Session.create({
			model: MODEL,
			createModelRunner: () => runner,
			createToolManager: () => (manager = new ToolManager()),
			configureTools: (tools) =>
				tools.register("state", () => statefulTool("state", () => ({ content: "ok" }), dispose)),
			toolRequests: [{ name: "state" }],
		});

		const aborted = session.agent.prompt("abort");
		await started.promise;
		session.agent.abort();
		pending.resolve(assistant("late"));
		await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
		expect(manager.status).toBe("ready");
		expect(dispose).not.toHaveBeenCalled();
		await expect(session.agent.prompt("next")).resolves.toMatchObject({
			finalAssistantMessage: { content: [{ text: "next succeeded" }] },
		});
		await session.dispose();
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("waits for an asynchronous tool factory before returning Session", async () => {
		const pendingTool = deferred<AgentTool>();
		let settled = false;
		const creating = Session.create({
			model: MODEL,
			createModelRunner: () => new ScriptedRunner([]),
			configureTools: (manager) => manager.register("state", async () => await pendingTool.promise),
			toolRequests: [{ name: "state" }],
		}).then((session) => {
			settled = true;
			return session;
		});

		await Promise.resolve();
		expect(settled).toBe(false);
		pendingTool.resolve(statefulTool("state", () => ({ content: "ok" })));
		const session = await creating;
		expect(session.agent).toBeDefined();
		await session.dispose();
	});

	it("aborts the lifetime signal and returns no Session after initialization failure", async () => {
		let lifetimeSignal!: AbortSignal;
		const creating = Session.create({
			model: MODEL,
			createModelRunner: ({ signal }) => {
				lifetimeSignal = signal;
				return new ScriptedRunner([]);
			},
			configureTools: (manager) =>
				manager.register("broken", () => {
					throw new Error("factory failed");
				}),
			toolRequests: [{ name: "broken" }],
		});

		await expect(creating).rejects.toThrow("factory failed");
		expect(lifetimeSignal.aborted).toBe(true);
	});

	it("disposes earlier tools in reverse order when Session creation fails", async () => {
		const disposed: string[] = [];
		const creating = Session.create({
			model: MODEL,
			createModelRunner: () => new ScriptedRunner([]),
			configureTools: (manager) => {
				manager.register("one", () =>
					statefulTool("one", () => ({ content: "ok" }), () => {
						disposed.push("one");
					}),
				);
				manager.register("two", () =>
					statefulTool("two", () => ({ content: "ok" }), () => {
						disposed.push("two");
					}),
				);
				manager.register("broken", () => {
					throw new Error("broken factory");
				});
			},
			toolRequests: [{ name: "one" }, { name: "two" }, { name: "broken" }],
		});

		await expect(creating).rejects.toThrow("broken factory");
		expect(disposed).toEqual(["two", "one"]);
	});

	it("disposes active run before tools and aborts lifetime after tools", async () => {
		const pending = deferred<AssistantMessage>();
		const started = deferred<void>();
		const events: string[] = [];
		let lifetimeSignal!: AbortSignal;
		const runner = new ScriptedRunner([
			async (_context, signal) => {
				signal.addEventListener("abort", () => events.push("run abort"), { once: true });
				started.resolve();
				return await pending.promise;
			},
		]);
		const session = await Session.create({
			model: MODEL,
			createModelRunner: ({ signal }) => {
				lifetimeSignal = signal;
				return runner;
			},
			configureTools: (manager) =>
				manager.register("state", () =>
					statefulTool(
						"state",
						() => ({ content: "ok" }),
						() => {
							expect(lifetimeSignal.aborted).toBe(false);
							events.push("tool dispose");
						},
					),
				),
			toolRequests: [{ name: "state" }],
		});

		const running = session.agent.prompt("run");
		await started.promise;
		const disposing = session.dispose();
		pending.resolve(assistant("late"));
		await expect(running).rejects.toMatchObject({ name: "AbortError" });
		await disposing;

		expect(events).toEqual(["run abort", "tool dispose"]);
		expect(lifetimeSignal.aborted).toBe(true);
	});

	it("dispose is idempotent, continues after tool errors, and blocks new prompts", async () => {
		const disposed: string[] = [];
		const session = await Session.create({
			model: MODEL,
			createModelRunner: () => new ScriptedRunner([]),
			configureTools: (manager) => {
				manager.register("one", () =>
					statefulTool("one", () => ({ content: "ok" }), () => {
						disposed.push("one");
					}),
				);
				manager.register("two", () =>
					statefulTool(
						"two",
						() => ({ content: "ok" }),
						() => {
							disposed.push("two");
							throw new Error("two dispose failed");
						},
					),
				);
			},
			toolRequests: [{ name: "one" }, { name: "two" }],
		});

		const firstDispose = session.dispose();
		await expect(session.agent.prompt("too late")).rejects.toThrow("Agent is disposed.");
		await expect(firstDispose).rejects.toMatchObject({ name: "AggregateError" });
		await expect(session.dispose()).rejects.toMatchObject({ name: "AggregateError" });
		expect(disposed).toEqual(["two", "one"]);
	});
});
