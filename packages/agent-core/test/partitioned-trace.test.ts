import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolCall, Usage } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	PartitionedJsonlTraceSink,
	Session,
	TraceEventHub,
	validateRunTraceEvents,
} from "../src/index.js";
import type { AgentContext, AgentModel, ModelRunner, TraceEvent } from "../src/index.js";

const USAGE: Usage = {
	input: 12, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 18,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
};
const MODEL: AgentModel = {
	id: "partition-model", name: "Partition Model", api: "test-api", provider: "test-provider",
	baseUrl: "https://invalid.test", reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10_000, maxTokens: 1_000,
};

function assistant(text: string, calls: readonly ToolCall[] = []): AssistantMessage {
	return {
		role: "assistant", content: calls.length > 0 ? [...calls] : [{ type: "text", text }],
		api: MODEL.api, provider: MODEL.provider, model: MODEL.id, usage: USAGE,
		stopReason: calls.length > 0 ? "toolUse" : "stop", timestamp: 1,
	};
}

class Runner implements ModelRunner {
	#next = 0;
	declare readonly replies: readonly AssistantMessage[];
	constructor(replies: readonly AssistantMessage[]) {
		this.replies = replies;
	}
	async run(_context: AgentContext): Promise<AssistantMessage> {
		const reply = this.replies[this.#next++];
		if (!reply) throw new Error("Unexpected model call");
		return reply;
	}
}

const directories: string[] = [];
const sessions: Session[] = [];
const hubs: TraceEventHub[] = [];

afterEach(async () => {
	await Promise.allSettled(sessions.splice(0).map(async (session) => await session.dispose()));
	await Promise.allSettled(hubs.splice(0).map(async (hub) => await hub.dispose()));
	await Promise.allSettled(directories.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

async function createFixture(replies: readonly AssistantMessage[], withTool = false) {
	const rootDir = await mkdtemp(join(tmpdir(), "ailoha-run-trace-"));
	directories.push(rootDir);
	const sink = new PartitionedJsonlTraceSink({ rootDir });
	const hub = new TraceEventHub({ sinks: [sink] });
	hubs.push(hub);
	const session = await Session.create({
		model: MODEL,
		createModelRunner: () => new Runner(replies),
		...(withTool ? {
			configureTools(manager: import("../src/index.js").ToolManager) {
				manager.register("calculator", () => ({
					name: "calculator", description: "calculate",
					parameters: Type.Object({ expression: Type.String() }),
					async execute() { return { content: "4" }; },
				}));
			},
			toolRequests: [{ name: "calculator" }],
		} : {}),
		trace: { sink: hub, sinkOwnership: "external" },
	}, { id: "session_safe" });
	sessions.push(session);
	return { rootDir, sink, hub, session };
}

async function stored(hub: TraceEventHub, sink: PartitionedJsonlTraceSink, runId: string): Promise<TraceEvent[]> {
	await hub.flush();
	await sink.flush();
	const path = await sink.completedTracePath("session_safe", runId);
	expect(path).toBeDefined();
	return (await readFile(path!, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as TraceEvent);
}

describe("PartitionedJsonlTraceSink", () => {
	it("writes the five-event direct-answer lifecycle and atomically removes .part", async () => {
		const { rootDir, sink, hub, session } = await createFixture([assistant("done")]);
		await session.agent.prompt("hello", { runId: "run_direct" });
		const events = await stored(hub, sink, "run_direct");
		expect(events.map((event) => event.type)).toEqual([
			"agent.run.started", "context.prepared", "llm.call.started", "llm.call.finished", "agent.run.finished",
		]);
		expect(validateRunTraceEvents(events)).toEqual([]);
		expect(events[3]).toMatchObject({ round: 1, decisionType: "final", usage: { totalTokens: 18 } });
		const files = await readdir(rootDir, { recursive: true });
		expect(files.some((name) => String(name).endsWith(".jsonl.part"))).toBe(false);
		expect(sink.stats()).toMatchObject({ completedRunFiles: 1, incompleteRunFiles: 0 });
		const beforeErrors = sink.stats().writeErrors;
		expect(() => sink.emit({ ...events.at(-1)!, eventId: "late_event", sequence: 6 })).not.toThrow();
		expect(sink.stats().writeErrors).toBe(beforeErrors + 1);
	});

	it("writes an ordered ten-event tool loop and redacts sensitive arguments", async () => {
		const toolCall: ToolCall = { type: "toolCall", id: "call_1", name: "calculator", arguments: { expression: "2+2", apiKey: "secret-canary" } };
		const { sink, hub, session } = await createFixture([assistant("", [toolCall]), assistant("4")], true);
		await session.agent.prompt("calculate", { runId: "run_tool", correlationId: "op_1" });
		const events = await stored(hub, sink, "run_tool");
		expect(events).toHaveLength(10);
		expect(events.filter((event) => event.type === "llm.call.started").map((event) => event.round)).toEqual([1, 2]);
		expect(validateRunTraceEvents(events)).toEqual([]);
		expect(JSON.stringify(events)).not.toContain("secret-canary");
	});

	it("isolates concurrent runs into separate files", async () => {
		const rootDir = await mkdtemp(join(tmpdir(), "ailoha-run-trace-concurrent-"));
		directories.push(rootDir);
		const sink = new PartitionedJsonlTraceSink({ rootDir });
		const hub = new TraceEventHub({ sinks: [sink] });
		hubs.push(hub);
		const make = async (id: string) => {
			const session = await Session.create({ model: MODEL, createModelRunner: () => new Runner([assistant(id)]), trace: { sink: hub, sinkOwnership: "external" } }, { id });
			sessions.push(session);
			return session;
		};
		const [a, b] = await Promise.all([make("session_a"), make("session_b")]);
		await Promise.all([a.agent.prompt("a", { runId: "run_a" }), b.agent.prompt("b", { runId: "run_b" })]);
		await hub.flush();
		await sink.flush();
		const paths = await Promise.all([sink.completedTracePath("session_a", "run_a"), sink.completedTracePath("session_b", "run_b")]);
		expect(paths[0]).not.toBe(paths[1]);
		for (const [index, path] of paths.entries()) {
			const text = await readFile(path!, "utf8");
			expect(text).toContain(index === 0 ? '"runId":"run_a"' : '"runId":"run_b"');
			expect(text).not.toContain(index === 0 ? '"runId":"run_b"' : '"runId":"run_a"');
		}
	});

	it("rejects unsafe path IDs without throwing from emit", () => {
		const onError = vi.fn();
		const sink = new PartitionedJsonlTraceSink({ rootDir: "D:/ailoha/artifacts/test-traces", onError });
		expect(() => sink.emit({
			schemaVersion: 1, eventId: "evt_1", type: "agent.run.started", timeUnixMs: 1,
			sequence: 1, sessionId: "../escape", runId: "run", inputMessageCount: 1, model: { id: "m" },
		})).not.toThrow();
		expect(sink.stats().writeErrors).toBe(1);
		expect(onError).toHaveBeenCalledOnce();
	});

	it("keeps an incomplete .part file when backpressure drops an event", async () => {
		const rootDir = await mkdtemp(join(tmpdir(), "ailoha-run-trace-pressure-"));
		directories.push(rootDir);
		const sink = new PartitionedJsonlTraceSink({ rootDir, maxPendingEvents: 1 });
		const base = {
			schemaVersion: 1 as const, timeUnixMs: Date.now(), sessionId: "session_pressure", runId: "run_pressure",
		};
		sink.emit({ ...base, eventId: "evt_1", sequence: 1, type: "agent.run.started", inputMessageCount: 1, model: { id: "m" } });
		sink.emit({
			...base, eventId: "evt_2", sequence: 2, type: "context.prepared",
			systemPromptCount: 0, toolCount: 0, historyMessageCount: 0, inputMessageCount: 1,
			totalMessageCount: 1, contextSha256: "sha256:test",
		});
		await sink.flush();
		const files = await readdir(rootDir, { recursive: true });
		expect(files.some((name) => String(name).endsWith(".jsonl.part"))).toBe(true);
		expect(sink.stats()).toMatchObject({ acceptedEvents: 1, droppedEvents: 1, incompleteRunFiles: 1, completedRunFiles: 0 });
		await sink.dispose();
	});

	it("writes a contiguous two-event file at summary level", async () => {
		const rootDir = await mkdtemp(join(tmpdir(), "ailoha-run-trace-summary-"));
		directories.push(rootDir);
		const sink = new PartitionedJsonlTraceSink({ rootDir });
		const hub = new TraceEventHub({ sinks: [sink] });
		hubs.push(hub);
		const session = await Session.create({
			model: MODEL,
			createModelRunner: () => new Runner([assistant("summary")]),
			trace: { sink: hub, sinkOwnership: "external", level: "summary" },
		}, { id: "session_summary" });
		sessions.push(session);
		await session.agent.prompt("hello", { runId: "run_summary" });
		await sink.flush();
		const path = await sink.completedTracePath("session_summary", "run_summary");
		const events = (await readFile(path!, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as TraceEvent);
		expect(events.map((event) => [event.sequence, event.type])).toEqual([
			[1, "agent.run.started"],
			[2, "agent.run.finished"],
		]);
		expect(validateRunTraceEvents(events)).toEqual([]);
	});
});
