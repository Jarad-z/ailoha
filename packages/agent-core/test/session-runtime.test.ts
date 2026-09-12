import { Type } from "@earendil-works/pi-ai";
import type { AssistantMessage, ToolCall, Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AgentStateError,
	DefaultContextManager,
	DuplicateSessionIdError,
	InvalidSessionIdError,
	Session,
	SessionCapacityError,
	SessionRuntime,
	SessionRuntimeStateError,
} from "../src/index.js";
import type {
	AgentContext,
	AgentModel,
	AgentTool,
	ModelRunner,
	SessionOptions,
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
	id: "runtime-test-model",
	name: "Runtime Test Model",
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

function toolAssistant(call: ToolCall): AssistantMessage {
	return { ...assistant(""), content: [call], stopReason: "toolUse" };
}

class ScriptedRunner implements ModelRunner {
	readonly snapshots: AgentContext[] = [];
	readonly #steps: ((context: AgentContext, signal: AbortSignal) => AssistantMessage | Promise<AssistantMessage>)[];

	constructor(steps: ((context: AgentContext, signal: AbortSignal) => AssistantMessage | Promise<AssistantMessage>)[]) {
		this.#steps = [...steps];
	}

	async run(context: AgentContext, options: { readonly signal: AbortSignal }): Promise<AssistantMessage> {
		this.snapshots.push(context);
		const step = this.#steps.shift();
		if (!step) throw new Error("Unexpected model call.");
		return await step(context, options.signal);
	}
}

function sessionOptions(runner: ModelRunner, configure?: SessionOptions["configureTools"]): SessionOptions {
	return {
		model: MODEL,
		createModelRunner: () => runner,
		configureTools: configure,
		toolRequests: configure ? [{ name: "state" }] : [],
	};
}

function stateTool(
	execute: (call: ToolCall) => ToolExecutionResult | Promise<ToolExecutionResult>,
	dispose?: () => void | Promise<void>,
): AgentTool {
	return {
		name: "state",
		description: "State test tool",
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

const runtimes: SessionRuntime[] = [];

function runtime(options?: ConstructorParameters<typeof SessionRuntime>[0]): SessionRuntime {
	const value = new SessionRuntime(options);
	runtimes.push(value);
	return value;
}

afterEach(async () => {
	await Promise.allSettled(runtimes.splice(0).map(async (value) => await value.dispose()));
	vi.restoreAllMocks();
});

describe("SessionRuntime registry", () => {
	it("rejects invalid explicit and generated IDs before calling the factory", async () => {
		const factory = vi.fn();
		const explicit = runtime({ createSession: factory });
		await expect(
			explicit.createSession({ id: "   ", session: sessionOptions(new ScriptedRunner([])) }),
		).rejects.toBeInstanceOf(InvalidSessionIdError);

		const generated = runtime({ generateSessionId: () => "", createSession: factory });
		await expect(
			generated.createSession({ session: sessionOptions(new ScriptedRunner([])) }),
		).rejects.toBeInstanceOf(InvalidSessionIdError);
		expect(factory).not.toHaveBeenCalled();
	});

	it("creates, indexes, lists, and disposes a stable handle", async () => {
		const value = runtime();
		const handle = await value.createSession({ id: "one", session: sessionOptions(new ScriptedRunner([])) });

		expect(handle.id).toBe("one");
		expect(handle.agent).toBeDefined();
		expect(value.getSession("one")).toBe(handle);
		expect(value.listSessions()).toMatchObject([
			{ id: "one", status: "ready", agentStatus: "idle" },
		]);
		expect(Object.isFrozen(value.listSessions())).toBe(true);
		expect(Object.isFrozen(value.listSessions()[0])).toBe(true);

		await expect(value.disposeSession("one")).resolves.toBe(true);
		expect(value.getSession("one")).toBeUndefined();
		await expect(value.disposeSession("one")).resolves.toBe(false);
		expect(handle.snapshot().status).toBe("disposed");
	});

	it("generates unique IDs and sorts snapshots deterministically", async () => {
		vi.spyOn(Date, "now").mockReturnValue(NOW);
		const ids = ["z", "a"];
		const value = runtime({ generateSessionId: () => ids.shift() ?? "unexpected" });
		const first = await value.createSession({ session: sessionOptions(new ScriptedRunner([])) });
		const second = await value.createSession({ session: sessionOptions(new ScriptedRunner([])) });

		expect([first.id, second.id]).toEqual(["z", "a"]);
		expect(value.listSessions().map(({ id }) => id)).toEqual(["a", "z"]);
	});

	it("reserves an ID before awaiting the factory", async () => {
		const lateSession = await Session.create(sessionOptions(new ScriptedRunner([])), { id: "same" });
		const release = deferred<Session>();
		const factory = vi.fn(async () => await release.promise);
		const value = runtime({ createSession: factory });

		const first = value.createSession({ id: "same", session: sessionOptions(new ScriptedRunner([])) });
		await expect(
			value.createSession({ id: "same", session: sessionOptions(new ScriptedRunner([])) }),
		).rejects.toBeInstanceOf(DuplicateSessionIdError);
		expect(factory).toHaveBeenCalledTimes(1);

		release.resolve(lateSession);
		await first;
	});

	it("starts factories for different IDs concurrently", async () => {
		const sessions = new Map([
			["a", await Session.create(sessionOptions(new ScriptedRunner([])), { id: "a" })],
			["b", await Session.create(sessionOptions(new ScriptedRunner([])), { id: "b" })],
		]);
		const releases = new Map<string, Deferred<void>>([
			["a", deferred<void>()],
			["b", deferred<void>()],
		]);
		const started: string[] = [];
		const value = runtime({
			async createSession(_options, context) {
				started.push(context.id);
				await releases.get(context.id)?.promise;
				return sessions.get(context.id) as Session;
			},
		});

		const creatingA = value.createSession({ id: "a", session: sessionOptions(new ScriptedRunner([])) });
		const creatingB = value.createSession({ id: "b", session: sessionOptions(new ScriptedRunner([])) });
		await vi.waitFor(() => expect(started).toEqual(["a", "b"]));
		expect(value.listSessions().map(({ status }) => status)).toEqual(["creating", "creating"]);

		releases.get("a")?.resolve();
		releases.get("b")?.resolve();
		await Promise.all([creatingA, creatingB]);
	});

	it("counts creating records toward capacity and releases failed reservations", async () => {
		const release = deferred<Session>();
		let fail = true;
		const value = runtime({
			maxSessions: 1,
			async createSession(options, context) {
				if (fail) throw new Error("factory failed");
				return await release.promise;
			},
		});

		await expect(
			value.createSession({ id: "slot", session: sessionOptions(new ScriptedRunner([])) }),
		).rejects.toThrow("factory failed");
		fail = false;
		const creating = value.createSession({ id: "slot", session: sessionOptions(new ScriptedRunner([])) });
		await expect(
			value.createSession({ id: "other", session: sessionOptions(new ScriptedRunner([])) }),
		).rejects.toBeInstanceOf(SessionCapacityError);

		release.resolve(await Session.create(sessionOptions(new ScriptedRunner([])), { id: "slot" }));
		await creating;
	});
});

describe("SessionRuntime concurrency and isolation", () => {
	it("runs different Sessions concurrently without a global lock", async () => {
		const aStarted = deferred<void>();
		const aRelease = deferred<void>();
		const runnerA = new ScriptedRunner([
			async () => {
				aStarted.resolve();
				await aRelease.promise;
				return assistant("A done");
			},
		]);
		const runnerB = new ScriptedRunner([async () => assistant("B done")]);
		const value = runtime();
		const [a, b] = await Promise.all([
			value.createSession({ id: "a", session: sessionOptions(runnerA) }),
			value.createSession({ id: "b", session: sessionOptions(runnerB) }),
		]);

		const runningA = a.agent.prompt("A prompt");
		await aStarted.promise;
		await expect(b.agent.prompt("B prompt")).resolves.toMatchObject({
			finalAssistantMessage: { content: [{ text: "B done" }] },
		});
		expect(a.agent.state.status).toBe("running");

		aRelease.resolve();
		await runningA;
	});

	it("keeps contexts, tool instances, state, and session IDs isolated", async () => {
		const initIds: string[] = [];
		const executionIds: string[] = [];
		const tools: AgentTool[] = [];
		const makeOptions = (id: string, runner: ModelRunner): SessionOptions => ({
			model: MODEL,
			createModelRunner: (context) => {
				expect(context.sessionId).toBe(id);
				return runner;
			},
			contextManagerOptions: { systemPrompts: [`system ${id}`] },
			configureTools(manager) {
				manager.register("state", (_request, initContext) => {
					initIds.push(initContext.sessionId);
					const items: string[] = [];
					const tool: AgentTool = {
						name: "state",
						description: "isolated state",
						parameters: Type.Object({ action: Type.String(), text: Type.Optional(Type.String()) }),
						async execute(call, context) {
							executionIds.push(context.sessionId);
							if (call.arguments.action === "add") items.push(String(call.arguments.text));
							return { content: JSON.stringify(items) };
						},
					};
					tools.push(tool);
					return tool;
				});
			},
			toolRequests: [{ name: "state" }],
		});
		const runnerA = new ScriptedRunner([
			async () => toolAssistant({ type: "toolCall", id: "a-add", name: "state", arguments: { action: "add", text: "A" } }),
			async () => assistant("A added"),
			async () => toolAssistant({ type: "toolCall", id: "a-list", name: "state", arguments: { action: "list" } }),
			async () => assistant("A listed"),
		]);
		const runnerB = new ScriptedRunner([
			async () => toolAssistant({ type: "toolCall", id: "b-list", name: "state", arguments: { action: "list" } }),
			async () => assistant("B listed"),
		]);
		const value = runtime();
		const [a, b] = await Promise.all([
			value.createSession({ id: "a", session: makeOptions("a", runnerA) }),
			value.createSession({ id: "b", session: makeOptions("b", runnerB) }),
		]);

		await Promise.all([a.agent.prompt("add A"), b.agent.prompt("list B")]);
		const aSecond = await a.agent.prompt("list A");
		const aList = aSecond.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "a-list",
		);
		const bList = runnerB.snapshots[1].messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "b-list",
		);

		expect(tools[0]).not.toBe(tools[1]);
		expect(initIds.sort()).toEqual(["a", "b"]);
		expect(executionIds.sort()).toEqual(["a", "a", "b"]);
		expect(aList?.content[0]).toMatchObject({ text: '["A"]' });
		expect(bList?.content[0]).toMatchObject({ text: "[]" });
		expect(runnerA.snapshots.every((context) => context.systemPrompt === "system a")).toBe(true);
		expect(runnerB.snapshots.every((context) => context.systemPrompt === "system b")).toBe(true);
		expect(
			runnerA.snapshots.flatMap((context) => context.messages).some((message) => message.role === "user" && message.content === "list B"),
		).toBe(false);
	});

	it("keeps the existing one-active-run rule inside one Session", async () => {
		const release = deferred<void>();
		const started = deferred<void>();
		const value = runtime();
		const handle = await value.createSession({
			id: "one",
			session: sessionOptions(
				new ScriptedRunner([
					async () => {
						started.resolve();
						await release.promise;
						return assistant("done");
					},
				]),
			),
		});

		const first = handle.agent.prompt("first");
		await started.promise;
		await expect(handle.agent.prompt("second")).rejects.toBeInstanceOf(AgentStateError);
		release.resolve();
		await first;
	});
});

describe("SessionRuntime cancellation and disposal", () => {
	it("rejects and disposes a factory result whose Session ID does not match", async () => {
		const dispose = vi.fn();
		const mismatched = await Session.create(
			sessionOptions(new ScriptedRunner([]), (manager) =>
				manager.register("state", () => stateTool(async () => ({ content: "ok" }), dispose)),
			),
			{ id: "actual" },
		);
		const value = runtime({ createSession: async () => mismatched });

		await expect(
			value.createSession({ id: "expected", session: sessionOptions(new ScriptedRunner([])) }),
		).rejects.toBeInstanceOf(SessionRuntimeStateError);
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(value.listSessions()).toEqual([]);
	});

	it("cancels a pending creation and disposes a factory's late result", async () => {
		const lateDispose = vi.fn();
		const lateSession = await Session.create(
			sessionOptions(new ScriptedRunner([]), (manager) =>
				manager.register("state", () => stateTool(async () => ({ content: "ok" }), lateDispose)),
			),
			{ id: "late" },
		);
		const release = deferred<void>();
		const started = deferred<void>();
		const value = runtime({
			async createSession(_options, context) {
				started.resolve();
				await release.promise;
				expect(context.signal.aborted).toBe(true);
				return lateSession;
			},
		});

		const creating = value.createSession({ id: "late", session: sessionOptions(new ScriptedRunner([])) });
		await started.promise;
		const disposing = value.disposeSession("late");
		expect(value.getSession("late")).toBeUndefined();
		expect(value.listSessions()).toMatchObject([{ id: "late", status: "disposing" }]);
		release.resolve();

		await expect(creating).rejects.toMatchObject({ name: "AbortError" });
		await expect(disposing).resolves.toBe(true);
		expect(lateDispose).toHaveBeenCalledTimes(1);
		expect(value.listSessions()).toEqual([]);
	});

	it("Runtime disposal waits for pending creation cleanup and never publishes it", async () => {
		const lateDispose = vi.fn();
		const lateSession = await Session.create(
			sessionOptions(new ScriptedRunner([]), (manager) =>
				manager.register("state", () => stateTool(async () => ({ content: "ok" }), lateDispose)),
			),
			{ id: "runtime-late" },
		);
		const release = deferred<void>();
		const started = deferred<void>();
		const value = runtime({
			async createSession() {
				started.resolve();
				await release.promise;
				return lateSession;
			},
		});
		const creating = value.createSession({
			id: "runtime-late",
			session: sessionOptions(new ScriptedRunner([])),
		});
		await started.promise;

		const disposing = value.dispose();
		expect(value.status).toBe("disposing");
		expect(value.getSession("runtime-late")).toBeUndefined();
		release.resolve();

		await expect(creating).rejects.toMatchObject({ name: "AbortError" });
		await disposing;
		expect(lateDispose).toHaveBeenCalledTimes(1);
		expect(value.status).toBe("disposed");
		expect(value.listSessions()).toEqual([]);
	});

	it("disposes one active Session without affecting another", async () => {
		const aStarted = deferred<void>();
		const aResponse = deferred<AssistantMessage>();
		const disposeA = vi.fn();
		const disposeB = vi.fn();
		const value = runtime();
		const [a, b] = await Promise.all([
			value.createSession({
				id: "a",
				session: sessionOptions(
					new ScriptedRunner([
						async () => {
							aStarted.resolve();
							return await aResponse.promise;
						},
					]),
					(manager) => manager.register("state", () => stateTool(async () => ({ content: "a" }), disposeA)),
				),
			}),
			value.createSession({
				id: "b",
				session: sessionOptions(
					new ScriptedRunner([async () => assistant("B remains available")]),
					(manager) => manager.register("state", () => stateTool(async () => ({ content: "b" }), disposeB)),
				),
			}),
		]);

		const runningA = a.agent.prompt("wait");
		await aStarted.promise;
		const firstDispose = a.dispose();
		const secondDispose = a.dispose();
		expect(firstDispose).toBe(secondDispose);
		aResponse.resolve(assistant("late"));

		await expect(runningA).rejects.toMatchObject({ name: "AbortError" });
		await Promise.all([firstDispose, secondDispose]);
		expect(disposeA).toHaveBeenCalledTimes(1);
		expect(disposeB).not.toHaveBeenCalled();
		await expect(b.agent.prompt("still works")).resolves.toBeDefined();
	});

	it("disposes all Sessions concurrently and aggregates cleanup failures", async () => {
		const started: string[] = [];
		const releaseA = deferred<void>();
		const releaseB = deferred<void>();
		const value = runtime();
		const make = (id: string, release: Deferred<void>, shouldFail: boolean) =>
			value.createSession({
				id,
				session: sessionOptions(new ScriptedRunner([]), (manager) =>
					manager.register("state", () =>
						stateTool(async () => ({ content: id }), async () => {
							started.push(id);
							await release.promise;
							if (shouldFail) throw new Error(`${id} cleanup failed`);
						}),
					),
				),
			});
		await Promise.all([make("a", releaseA, true), make("b", releaseB, false)]);

		const disposing = value.dispose();
		expect(value.status).toBe("disposing");
		await vi.waitFor(() => expect(started.sort()).toEqual(["a", "b"]));
		releaseA.resolve();
		releaseB.resolve();

		await expect(disposing).rejects.toMatchObject({ name: "AggregateError" });
		expect(value.status).toBe("disposed");
		expect(value.listSessions()).toEqual([]);
		await expect(value.dispose()).rejects.toMatchObject({ name: "AggregateError" });
	});

	it("rejects new creation immediately after Runtime disposal starts", async () => {
		const value = runtime();
		const disposing = value.dispose();

		await expect(
			value.createSession({ id: "too-late", session: sessionOptions(new ScriptedRunner([])) }),
		).rejects.toBeInstanceOf(SessionRuntimeStateError);
		await disposing;
	});

	it("allows an ID to be reused after disposal with fresh context and tools", async () => {
		const value = runtime();
		const firstTool = vi.fn(() => stateTool(async () => ({ content: "first" })));
		const first = await value.createSession({
			id: "reused",
			session: sessionOptions(new ScriptedRunner([]), (manager) => manager.register("state", firstTool)),
		});
		await first.dispose();

		const secondTool = vi.fn(() => stateTool(async () => ({ content: "second" })));
		const second = await value.createSession({
			id: "reused",
			session: sessionOptions(new ScriptedRunner([]), (manager) => manager.register("state", secondTool)),
		});

		expect(second).not.toBe(first);
		expect(second.agent).not.toBe(first.agent);
		expect(firstTool).toHaveBeenCalledTimes(1);
		expect(secondTool).toHaveBeenCalledTimes(1);
	});
});
