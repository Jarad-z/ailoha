import { afterEach, describe, expect, it } from "vitest";
import {
	InMemoryTraceSink,
	TraceCursorExpiredError,
	TraceEventHub,
	TraceSubscriptionOverflowError,
} from "../src/index.js";
import type {
	RunStartedEvent,
	TraceDelivery,
	TraceEvent,
	TraceIdGenerator,
	TraceIdKind,
	TraceSink,
} from "../src/index.js";

class DeterministicIds implements TraceIdGenerator {
	readonly #counts = new Map<TraceIdKind, number>();

	generate(kind: TraceIdKind): string {
		const next = (this.#counts.get(kind) ?? 0) + 1;
		this.#counts.set(kind, next);
		return `${kind}_${next}`;
	}
}

function runStarted(eventId: string, sessionId = "session-a", runId = "run-a"): RunStartedEvent {
	return Object.freeze({
		schemaVersion: 1,
		eventId,
		type: "agent.run.started",
		timeUnixMs: 1,
		sequence: 1,
		sessionId,
		runId,
		inputMessageCount: 1,
		model: Object.freeze({ id: "test" }),
	});
}

function runFinished(eventId: string, sessionId = "session-a", runId = "run-a"): TraceEvent {
	return Object.freeze({
		schemaVersion: 1,
		eventId,
		type: "agent.run.finished",
		timeUnixMs: 2,
		sequence: 2,
		sessionId,
		runId,
		outcome: "success",
		durationMs: 1,
		assistantTurnCount: 1,
		toolCallCount: 0,
	});
}

async function nextValue(iterator: AsyncIterator<TraceDelivery>): Promise<TraceDelivery> {
	const next = await iterator.next();
	if (next.done) throw new Error("Subscription ended unexpectedly.");
	return next.value;
}

const hubs: TraceEventHub[] = [];

afterEach(async () => {
	await Promise.allSettled(hubs.splice(0).map(async (hub) => await hub.dispose()));
});

describe("TraceEventHub", () => {
	it("counts only matching replay records against subscriber capacity and then continues live", async () => {
		const hub = new TraceEventHub({ replayCapacity: 10, idGenerator: new DeterministicIds() });
		hubs.push(hub);
		hub.emit(runStarted("a"));
		hub.emit(runFinished("b"));
		hub.emit(runStarted("c", "session-b", "run-b"));

		const subscription = hub.subscribe({
			start: { mode: "earliest_available" },
			bufferCapacity: 1,
			filter: { sessionIds: ["session-b"] },
		});
		const iterator = subscription[Symbol.asyncIterator]();
		expect(await nextValue(iterator)).toMatchObject({ kind: "event", event: { eventId: "c" } });

		hub.emit(runFinished("d", "session-b", "run-b"));
		expect(await nextValue(iterator)).toMatchObject({ kind: "event", event: { eventId: "d" } });
		expect(subscription.snapshot()).toMatchObject({ deliveredEvents: 2, filteredEvents: 2 });
	});

	it("closes only the overflowing subscriber", async () => {
		const persisted = new InMemoryTraceSink();
		const hub = new TraceEventHub({ sinks: [persisted], idGenerator: new DeterministicIds() });
		hubs.push(hub);
		const slow = hub.subscribe({ bufferCapacity: 1 });
		const fast = hub.subscribe({ bufferCapacity: 4 });

		hub.emit(runStarted("a"));
		hub.emit(runFinished("b"));

		await expect(slow[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(TraceSubscriptionOverflowError);
		expect(await nextValue(fast[Symbol.asyncIterator]())).toMatchObject({ event: { eventId: "a" } });
		expect(persisted.snapshot().map((event) => event.eventId)).toEqual(["a", "b"]);
		expect(hub.subscriberCount).toBe(1);
	});

	it("reports an explicit gap when drop_oldest discards buffered records", async () => {
		const hub = new TraceEventHub({ idGenerator: new DeterministicIds() });
		hubs.push(hub);
		const subscription = hub.subscribe({ bufferCapacity: 2, overflow: "drop_oldest" });
		const iterator = subscription[Symbol.asyncIterator]();

		hub.emit(runStarted("a"));
		hub.emit(runFinished("b"));
		hub.emit(runStarted("c", "session-b", "run-b"));

		expect(await nextValue(iterator)).toMatchObject({ kind: "gap", droppedCount: 1 });
		expect(await nextValue(iterator)).toMatchObject({ kind: "event", event: { eventId: "b" } });
		expect(await nextValue(iterator)).toMatchObject({ kind: "event", event: { eventId: "c" } });
	});

	it("rejects a cursor that has fallen out of the replay ring", () => {
		const hub = new TraceEventHub({ replayCapacity: 2, idGenerator: new DeterministicIds() });
		hubs.push(hub);
		hub.emit(runStarted("a"));
		const expiredCursor = hub.snapshot()[0].cursor;
		hub.emit(runFinished("b"));
		hub.emit(runStarted("c", "session-b", "run-b"));

		expect(() => hub.subscribe({ start: { mode: "after", cursor: expiredCursor } })).toThrow(
			TraceCursorExpiredError,
		);
		expect(hub.subscriberCount).toBe(0);
	});

	it("queues reentrant emits so every downstream sink sees the same order", () => {
		let hub!: TraceEventHub;
		const second = runFinished("b");
		const firstSink: TraceSink = {
			emit(event) {
				if (event.eventId === "a") hub.emit(second);
			},
		};
		const observed: string[] = [];
		const secondSink: TraceSink = { emit: (event) => observed.push(event.eventId) };
		hub = new TraceEventHub({ sinks: [firstSink, secondSink], idGenerator: new DeterministicIds() });
		hubs.push(hub);

		hub.emit(runStarted("a"));

		expect(observed).toEqual(["a", "b"]);
		expect(hub.snapshot().map((record) => record.event.eventId)).toEqual(["a", "b"]);
	});
});
