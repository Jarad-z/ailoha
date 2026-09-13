import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AssistantMessage, ToolCall, Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	InMemoryTraceSink,
	JsonlTraceSink,
	Session,
	SessionRuntime,
	TraceEventHub,
} from "../src/index.js";
import type {
	AgentContext,
	AgentModel,
	AgentTool,
	ModelRunner,
	TraceDelivery,
	TraceEvent,
	TraceIdGenerator,
	TraceIdKind,
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
	id: "trace-e2e-model",
	name: "Trace E2E Model",
	api: "test-api",
	provider: "test-provider",
	baseUrl: "https://invalid.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_000,
};

class DeterministicIds implements TraceIdGenerator {
	readonly #counts = new Map<TraceIdKind, number>();

	generate(kind: TraceIdKind): string {
		const next = (this.#counts.get(kind) ?? 0) + 1;
		this.#counts.set(kind, next);
		return `${kind}_${String(next).padStart(3, "0")}`;
	}
}

class ScriptedRunner implements ModelRunner {
	readonly #steps: readonly ((context: AgentContext, signal: AbortSignal) => AssistantMessage | Promise<AssistantMessage>)[];
	#next = 0;

	constructor(steps: readonly ((context: AgentContext, signal: AbortSignal) => AssistantMessage | Promise<AssistantMessage>)[]) {
		this.#steps = steps;
	}

	async run(context: AgentContext, options: { readonly signal: AbortSignal }): Promise<AssistantMessage> {
		const step = this.#steps[this.#next++];
		if (!step) throw new Error("Unexpected model call.");
		return await step(context, options.signal);
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
		timestamp: NOW,
	};
}

function call(id: string, argumentsValue: Record<string, unknown>): ToolCall {
	return { type: "toolCall", id, name: "search", arguments: argumentsValue };
}

function searchTool(execute?: AgentTool["execute"]): AgentTool {
	return {
		name: "search",
		description: "Search test data",
		parameters: Type.Object(
			{ query: Type.String(), apiKey: Type.Optional(Type.String()) },
			{ additionalProperties: false },
		),
		async execute(toolCall, context) {
			return execute ? await execute(toolCall, context) : { content: `found:${toolCall.arguments.query}` };
		},
	};
}

async function take(subscription: AsyncIterator<TraceDelivery>, count: number): Promise<TraceDelivery[]> {
	const deliveries: TraceDelivery[] = [];
	for (let index = 0; index < count; index++) {
		const next = await subscription.next();
		if (next.done) throw new Error(`Trace subscription closed after ${index} deliveries.`);
		deliveries.push(next.value);
	}
	return deliveries;
}

const cleanupDirectories: string[] = [];
const cleanupSessions: Session[] = [];
const cleanupRuntimes: SessionRuntime[] = [];
const cleanupHubs: TraceEventHub[] = [];

afterEach(async () => {
	await Promise.allSettled(cleanupSessions.splice(0).map(async (session) => await session.dispose()));
	await Promise.allSettled(cleanupRuntimes.splice(0).map(async (runtime) => await runtime.dispose()));
	await Promise.allSettled(cleanupHubs.splice(0).map(async (hub) => await hub.dispose()));
	await Promise.allSettled(cleanupDirectories.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

describe("Trace end-to-end", () => {
	it("records and publishes one successful tool lifecycle with a caller-provided run ID", async () => {
		const ids = new DeterministicIds();
		const persisted = new InMemoryTraceSink();
		const hub = new TraceEventHub({ sinks: [persisted], idGenerator: ids });
		cleanupHubs.push(hub);
		const subscription = hub.subscribe({
			start: { mode: "latest" },
			filter: { eventTypes: ["tool.call.requested", "tool.call.started", "tool.call.finished"] },
		});
		const runner = new ScriptedRunner([
			async () => assistant("", [call("provider-call-1", { query: "docs", apiKey: "secret-canary" })]),
			async () => assistant("done"),
		]);
		const session = await Session.create({
			model: MODEL,
			createModelRunner: () => runner,
			configureTools(manager) {
				manager.register("search", () => searchTool());
			},
			toolRequests: [{ name: "search" }],
			trace: { sink: hub, sinkOwnership: "external", idGenerator: ids },
		});
		cleanupSessions.push(session);

		const result = await session.agent.prompt("find docs", { runId: "run_web_001", correlationId: "op_001" });
		const deliveries = await take(subscription[Symbol.asyncIterator](), 3);
		const records = deliveries.filter((delivery) => delivery.kind === "event");
		const events = records.map((record) => record.event);

		expect(result.runId).toBe("run_web_001");
		expect(events.map((event) => event.type)).toEqual([
			"tool.call.requested",
			"tool.call.started",
			"tool.call.finished",
		]);
		expect(events.every((event) => event.runId === "run_web_001" && event.correlationId === "op_001")).toBe(true);
		const requested = events[0];
		expect(requested).toMatchObject({
			type: "tool.call.requested",
			arguments: { mode: "redacted", value: { apiKey: "[REDACTED]", query: "docs" } },
		});
		expect(events[2]).toMatchObject({ type: "tool.call.finished", outcome: "success" });
		expect(JSON.stringify(persisted.snapshot())).not.toContain("secret-canary");
		expect(persisted.snapshot().map((event) => event.type)).toEqual([
			"agent.run.started",
			"context.prepared",
			"llm.call.started",
			"llm.call.finished",
			"tool.call.requested",
			"tool.call.started",
			"tool.call.finished",
			"llm.call.started",
			"llm.call.finished",
			"agent.run.finished",
		]);
	});

	it("closes the active and remaining tool traces when a run is aborted", async () => {
		let notifyStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			notifyStarted = resolve;
		});
		const sink = new InMemoryTraceSink();
		const session = await Session.create({
			model: MODEL,
			createModelRunner: () =>
				new ScriptedRunner([
					async () =>
						assistant("", [
							call("provider-call-a", { query: "a" }),
							call("provider-call-b", { query: "b" }),
						]),
				]),
			configureTools(manager) {
				manager.register("search", () =>
					searchTool(async (_toolCall, context) => {
						notifyStarted();
						return await new Promise((resolve, reject) => {
							context.signal.addEventListener(
								"abort",
								() => reject(context.signal.reason),
								{ once: true },
							);
						});
					}),
				);
			},
			toolRequests: [{ name: "search" }],
			trace: { sink },
		});
		cleanupSessions.push(session);

		const running = session.agent.prompt("run both", { runId: "run_abort_001" });
		await started;
		session.agent.abort();
		await expect(running).rejects.toMatchObject({ name: "AbortError" });

		const events = sink.snapshot();
		const requested = events.filter((event) => event.type === "tool.call.requested");
		const startedEvents = events.filter((event) => event.type === "tool.call.started");
		const finished = events.filter((event) => event.type === "tool.call.finished");
		expect(requested).toHaveLength(2);
		expect(startedEvents).toHaveLength(1);
		expect(finished).toMatchObject([
			{ toolCallId: "provider-call-a", outcome: "cancelled", failureStage: "cancellation" },
			{ toolCallId: "provider-call-b", outcome: "skipped", failureStage: "cancellation" },
		]);
		expect(events.at(-1)).toMatchObject({ type: "agent.run.finished", outcome: "cancelled" });
	});

	it("replays from a cursor, continues live, and writes the same events to JSONL", async () => {
		const directory = await mkdtemp(join(tmpdir(), "ailoha-trace-"));
		cleanupDirectories.push(directory);
		const tracePath = join(directory, "trace.jsonl");
		const jsonl = new JsonlTraceSink({ path: tracePath });
		const ids = new DeterministicIds();
		const hub = new TraceEventHub({ replayCapacity: 20, sinks: [jsonl], idGenerator: ids });
		cleanupHubs.push(hub);
		const session = await Session.create({
			model: MODEL,
			createModelRunner: () =>
				new ScriptedRunner([async () => assistant("first"), async () => assistant("second")]),
			trace: { sink: hub, sinkOwnership: "external", idGenerator: ids },
		});
		cleanupSessions.push(session);

		await session.agent.prompt("one", { runId: "run_one" });
		const firstCursor = hub.snapshot()[0].cursor;
		const subscription = hub.subscribe({ start: { mode: "after", cursor: firstCursor } });
		await session.agent.prompt("two", { runId: "run_two" });

		const deliveries = await take(subscription[Symbol.asyncIterator](), 9);
		const records = deliveries.filter((delivery) => delivery.kind === "event");
		expect(records.map((record) => record.event.type)).toEqual([
			"context.prepared",
			"llm.call.started",
			"llm.call.finished",
			"agent.run.finished",
			"agent.run.started",
			"context.prepared",
			"llm.call.started",
			"llm.call.finished",
			"agent.run.finished",
		]);
		expect(records.map((record) => record.event.runId)).toEqual([
			"run_one", "run_one", "run_one", "run_one",
			"run_two", "run_two", "run_two", "run_two", "run_two",
		]);

		await hub.flush();
		const lines = (await readFile(tracePath, "utf8")).trim().split("\n");
		const stored = lines.map((line) => JSON.parse(line) as TraceEvent);
		expect(stored).toHaveLength(10);
		expect(stored.map((event) => event.eventId)).toEqual(hub.snapshot().map((record) => record.event.eventId));
	});

	it("keeps concurrent SessionRuntime traces isolated while sharing one event Hub", async () => {
		const sink = new InMemoryTraceSink();
		const hub = new TraceEventHub({ sinks: [sink] });
		cleanupHubs.push(hub);
		const runtime = new SessionRuntime();
		cleanupRuntimes.push(runtime);
		const [alpha, beta] = await Promise.all([
			runtime.createSession({
				id: "alpha",
				session: {
					model: MODEL,
					createModelRunner: () => new ScriptedRunner([async () => assistant("alpha done")]),
					trace: { sink: hub, sinkOwnership: "external" },
				},
			}),
			runtime.createSession({
				id: "beta",
				session: {
					model: MODEL,
					createModelRunner: () => new ScriptedRunner([async () => assistant("beta done")]),
					trace: { sink: hub, sinkOwnership: "external" },
				},
			}),
		]);

		await Promise.all([
			alpha.agent.prompt("alpha", { runId: "run_alpha" }),
			beta.agent.prompt("beta", { runId: "run_beta" }),
		]);

		const events = sink.snapshot();
		expect(events.filter((event) => event.sessionId === "alpha").map((event) => [event.runId, event.type])).toEqual([
			["run_alpha", "agent.run.started"],
			["run_alpha", "context.prepared"],
			["run_alpha", "llm.call.started"],
			["run_alpha", "llm.call.finished"],
			["run_alpha", "agent.run.finished"],
		]);
		expect(events.filter((event) => event.sessionId === "beta").map((event) => [event.runId, event.type])).toEqual([
			["run_beta", "agent.run.started"],
			["run_beta", "context.prepared"],
			["run_beta", "llm.call.started"],
			["run_beta", "llm.call.finished"],
			["run_beta", "agent.run.finished"],
		]);
	});
});
