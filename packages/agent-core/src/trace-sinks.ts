import { appendFile, mkdir, open, rename, access } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
	InvalidTraceCursorError,
	TraceCursorExpiredError,
	TraceHubStateError,
	TraceReplayLimitError,
	TraceSubscriptionOverflowError,
	toError,
} from "./errors.js";
import { DefaultTraceIdGenerator } from "./trace-recorder.js";
import type {
	JsonlTraceSinkOptions,
	PartitionedJsonlTraceSinkOptions,
	PartitionedTraceSinkStats,
	RunTraceStore,
	TraceDelivery,
	TraceEvent,
	TraceEventHubOptions,
	TraceFilter,
	TraceGap,
	TraceIdGenerator,
	TraceRecord,
	TraceSink,
	TraceSinkStats,
	TraceSource,
	TraceSubscription,
	TraceSubscriptionOptions,
	TraceSubscriptionSnapshot,
} from "./trace-types.js";

function safeOnError(onError: ((error: Error) => void) | undefined, cause: unknown): void {
	try {
		onError?.(toError(cause));
	} catch {
		// A logging failure must not escape the observation path.
	}
}

const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

function validateTracePathId(name: string, value: string): string {
	if (!SAFE_TRACE_ID.test(value) || value === "." || value === "..") {
		throw new TypeError(`${name} contains characters that are unsafe for a Trace path.`);
	}
	return value;
}

function containedPath(rootDir: string, ...segments: string[]): string {
	const root = resolve(rootDir);
	const candidate = resolve(root, ...segments);
	const relation = relative(root, candidate);
	if (relation === "" || relation.startsWith("..") || isAbsolute(relation)) {
		throw new TypeError("Resolved Trace path is outside rootDir.");
	}
	return candidate;
}

export function validateRunTraceEvents(events: readonly TraceEvent[]): readonly string[] {
	const errors: string[] = [];
	if (events.length === 0) return Object.freeze(["Trace is empty."]);
	const starts = events.filter((event) => event.type === "agent.run.started");
	const finishes = events.filter((event) => event.type === "agent.run.finished");
	if (starts.length !== 1 || events[0]?.type !== "agent.run.started") errors.push("Trace must start with exactly one agent.run.started.");
	if (finishes.length !== 1 || events.at(-1)?.type !== "agent.run.finished") errors.push("Trace must end with exactly one agent.run.finished.");
	const sessionId = events[0]?.sessionId;
	const runId = events[0]?.runId;
	if (events.some((event) => event.sessionId !== sessionId || event.runId !== runId)) errors.push("Trace contains mixed sessionId or runId values.");
	if (events.some((event, index) => event.sequence !== index + 1)) errors.push("Trace sequences must start at 1 and increase strictly by one.");

	const llmStarts = new Map<string, number>();
	const llmFinishes = new Map<string, number>();
	const requested = new Map<string, number>();
	const toolStarted = new Map<string, number>();
	const toolFinished = new Map<string, number>();
	const compactStarts = new Map<string, number>();
	const compactFinishes = new Map<string, number>();
	for (const [index, event] of events.entries()) {
		if (event.type === "llm.call.started") llmStarts.set(event.llmCallId, index);
		if (event.type === "llm.call.finished") llmFinishes.set(event.llmCallId, index);
		if (event.type === "tool.call.requested") requested.set(event.toolExecutionId, index);
		if (event.type === "tool.call.started") toolStarted.set(event.toolExecutionId, index);
		if (event.type === "tool.call.finished") toolFinished.set(event.toolExecutionId, index);
		if (event.type === "context.compact.started") compactStarts.set(event.compactId, index);
		if (event.type === "context.compact.finished") compactFinishes.set(event.compactId, index);
	}
	if (llmStarts.size !== events.filter((event) => event.type === "llm.call.started").length || llmFinishes.size !== events.filter((event) => event.type === "llm.call.finished").length) errors.push("LLM call IDs must be unique.");
	for (const [id, start] of llmStarts) {
		const finish = llmFinishes.get(id);
		if (finish === undefined || finish <= start) errors.push(`LLM call ${id} does not have an ordered finish.`);
	}
	if (llmStarts.size !== llmFinishes.size || [...llmFinishes.keys()].some((id) => !llmStarts.has(id))) errors.push("LLM started and finished calls do not match.");
	const startedRounds = events.filter(
		(event): event is Extract<TraceEvent, { type: "llm.call.started" }> => event.type === "llm.call.started",
	).map((event) => event.round);
	if (startedRounds.some((round, index) => round !== index + 1)) errors.push("LLM rounds must start at 1 and increase strictly by one.");
	for (const event of events) {
		if (event.type === "llm.call.finished") {
			const start = events[llmStarts.get(event.llmCallId) ?? -1];
			if (start?.type !== "llm.call.started" || start.round !== event.round) errors.push(`LLM call ${event.llmCallId} changed round.`);
		}
	}
	for (const [id, requestIndex] of requested) {
		const finishIndex = toolFinished.get(id);
		const startIndex = toolStarted.get(id);
		if (finishIndex === undefined || finishIndex <= requestIndex) errors.push(`Tool execution ${id} does not have an ordered finish.`);
		if (startIndex !== undefined && (startIndex <= requestIndex || finishIndex === undefined || startIndex >= finishIndex)) errors.push(`Tool execution ${id} has an invalid started event position.`);
	}
	if (requested.size !== events.filter((event) => event.type === "tool.call.requested").length || toolStarted.size !== events.filter((event) => event.type === "tool.call.started").length || toolFinished.size !== events.filter((event) => event.type === "tool.call.finished").length) errors.push("Tool execution IDs must be unique per lifecycle stage.");
	if (requested.size !== toolFinished.size || [...toolFinished.keys()].some((id) => !requested.has(id)) || [...toolStarted.keys()].some((id) => !requested.has(id))) errors.push("Tool execution lifecycles do not match.");
	for (const [id, start] of compactStarts) {
		const finish = compactFinishes.get(id);
		if (finish === undefined || finish <= start) errors.push(`Context compact ${id} does not have an ordered finish.`);
	}
	if (compactStarts.size !== compactFinishes.size || [...compactFinishes.keys()].some((id) => !compactStarts.has(id))) errors.push("Context compact lifecycles do not match.");

	const terminal = events.at(-1);
	if (terminal?.type === "agent.run.finished") {
		const summaryOnly = events.every((event) => event.type === "agent.run.started" || event.type === "agent.run.finished");
		const assistants = events.filter((event) => event.type === "llm.call.finished" && event.outcome === "success").length;
		if (!summaryOnly && terminal.assistantTurnCount !== assistants) errors.push("assistantTurnCount does not match successful LLM calls.");
		if (!summaryOnly && terminal.toolCallCount !== requested.size) errors.push("toolCallCount does not match requested tools.");
		if (!summaryOnly && terminal.outcome === "success") {
			const lastSuccess = events.filter(
				(event): event is Extract<TraceEvent, { type: "llm.call.finished" }> =>
					event.type === "llm.call.finished" && event.outcome === "success",
			).at(-1);
			if (!lastSuccess || lastSuccess.decisionType !== "final") errors.push("A successful Run must end with a final LLM decision.");
		}
	}
	return Object.freeze(errors);
}

function validateCapacity(name: string, value: number): number {
	if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer.`);
	return value;
}

export class InMemoryTraceSink implements TraceSink {
	readonly #maxEvents: number;
	readonly #events: TraceEvent[] = [];
	#droppedEvents = 0;

	constructor(maxEvents = 10_000) {
		this.#maxEvents = validateCapacity("maxEvents", maxEvents);
	}

	emit(event: TraceEvent): void {
		if (this.#events.length >= this.#maxEvents) {
			this.#droppedEvents++;
			return;
		}
		this.#events.push(event);
	}

	snapshot(): readonly TraceEvent[] {
		return Object.freeze([...this.#events]);
	}

	stats(): TraceSinkStats {
		return Object.freeze({
			acceptedEvents: this.#events.length,
			droppedEvents: this.#droppedEvents,
			writeErrors: 0,
		});
	}
}

export class ConsoleTraceSink implements TraceSink {
	readonly #write: (line: string) => void;

	constructor(write: (line: string) => void = console.log) {
		this.#write = write;
	}

	emit(event: TraceEvent): void {
		const prefix = `${new Date(event.timeUnixMs).toISOString()} run=${event.runId}`;
		if (event.type === "agent.run.started") {
			this.#write(`${prefix} started model=${event.model.id}`);
			return;
		}
		if (event.type === "agent.run.finished") {
			this.#write(`${prefix} finished outcome=${event.outcome} duration=${event.durationMs.toFixed(1)}ms`);
			return;
		}
		if (!event.type.startsWith("tool.call.")) {
			this.#write(`${prefix} ${event.type}`);
			return;
		}
		const toolEvent = event as Extract<TraceEvent, { toolName: string }>;
		const toolPrefix = `${prefix} tool=${toolEvent.toolName} exec=${toolEvent.toolExecutionId}`;
		if (toolEvent.type === "tool.call.requested") this.#write(`${toolPrefix} requested ordinal=${toolEvent.ordinal}`);
		else if (toolEvent.type === "tool.call.started") {
			this.#write(`${toolPrefix} started queue=${toolEvent.queueDurationMs.toFixed(1)}ms`);
		} else {
			this.#write(`${toolPrefix} finished outcome=${toolEvent.outcome} total=${toolEvent.totalDurationMs.toFixed(1)}ms`);
		}
	}
}

export class JsonlTraceSink implements TraceSink {
	readonly #path: string;
	readonly #maxPendingEvents: number;
	readonly #onError: JsonlTraceSinkOptions["onError"];
	#queue: Promise<void> = Promise.resolve();
	#pendingEvents = 0;
	#acceptedEvents = 0;
	#droppedEvents = 0;
	#writeErrors = 0;
	#disposed = false;
	#disposePromise?: Promise<void>;

	constructor(options: JsonlTraceSinkOptions) {
		this.#path = options.path;
		this.#maxPendingEvents = validateCapacity("maxPendingEvents", options.maxPendingEvents ?? 1_000);
		this.#onError = options.onError;
	}

	emit(event: TraceEvent): void {
		if (this.#disposed || this.#pendingEvents >= this.#maxPendingEvents) {
			this.#droppedEvents++;
			if (this.#disposed) safeOnError(this.#onError, new TraceHubStateError("JsonlTraceSink is disposed."));
			return;
		}

		let line: string;
		try {
			line = `${JSON.stringify(event)}\n`;
		} catch (error) {
			this.#writeErrors++;
			safeOnError(this.#onError, error);
			return;
		}

		this.#acceptedEvents++;
		this.#pendingEvents++;
		this.#queue = this.#queue
			.then(async () => {
				await mkdir(dirname(this.#path), { recursive: true });
				await appendFile(this.#path, line, "utf8");
			})
			.catch((error) => {
				this.#writeErrors++;
				safeOnError(this.#onError, error);
			})
			.finally(() => {
				this.#pendingEvents--;
			});
	}

	async flush(): Promise<void> {
		await this.#queue;
	}

	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#disposed = true;
		this.#disposePromise = this.flush();
		return this.#disposePromise;
	}

	stats(): TraceSinkStats {
		return Object.freeze({
			acceptedEvents: this.#acceptedEvents,
			droppedEvents: this.#droppedEvents,
			writeErrors: this.#writeErrors,
		});
	}
}

interface PartitionedRunState {
	readonly key: string;
	readonly sessionId: string;
	readonly runId: string;
	readonly partPath: string;
	readonly finalPath: string;
	readonly events: TraceEvent[];
	queue: Promise<void>;
	handle?: FileHandle;
	terminalAccepted: boolean;
	completed: boolean;
	failed: boolean;
	writeBlocked: boolean;
	incompleteCounted: boolean;
}

export class PartitionedJsonlTraceSink implements TraceSink, RunTraceStore {
	readonly #rootDir: string;
	readonly #maxPendingEvents: number;
	readonly #fsyncOnRunFinish: boolean;
	readonly #onError: PartitionedJsonlTraceSinkOptions["onError"];
	readonly #runs = new Map<string, PartitionedRunState>();
	#pendingEvents = 0;
	#acceptedEvents = 0;
	#droppedEvents = 0;
	#writeErrors = 0;
	#completedRunFiles = 0;
	#incompleteRunFiles = 0;
	#flushDurationMs = 0;
	#disposed = false;
	#disposePromise?: Promise<void>;

	constructor(options: PartitionedJsonlTraceSinkOptions) {
		if (!options.rootDir || options.rootDir.trim() === "") throw new TypeError("rootDir must not be empty.");
		this.#rootDir = resolve(options.rootDir);
		this.#maxPendingEvents = validateCapacity("maxPendingEvents", options.maxPendingEvents ?? 1_000);
		this.#fsyncOnRunFinish = options.fsyncOnRunFinish ?? false;
		this.#onError = options.onError;
	}

	emit(event: TraceEvent): void {
		if (this.#disposed) {
			this.#drop(undefined, new TraceHubStateError("PartitionedJsonlTraceSink is disposed."));
			return;
		}

		let line: string;
		try {
			line = `${JSON.stringify(event)}\n`;
		} catch (error) {
			this.#writeFailure(undefined, error);
			return;
		}

		let state = this.#runs.get(this.#key(event.sessionId, event.runId));
		if (event.type === "agent.run.started") {
			if (state) {
				this.#writeFailure(state, new Error(`Duplicate agent.run.started for Run ${event.runId}.`));
				return;
			}
			try {
				state = this.#createRunState(event);
				this.#runs.set(state.key, state);
			} catch (error) {
				this.#writeFailure(undefined, error);
				return;
			}
		} else if (!state) {
			this.#writeFailure(undefined, new Error(`Trace event arrived before agent.run.started for Run ${event.runId}.`));
			return;
		}

		if (state.completed || state.terminalAccepted) {
			this.#writeFailure(state, new Error(`Cannot append to completed Run ${event.runId}.`));
			return;
		}
		if (state.failed) {
			this.#drop(undefined, new Error(`Run ${event.runId} Trace is already incomplete.`));
			return;
		}
		if (this.#pendingEvents >= this.#maxPendingEvents) {
			this.#drop(state, new Error(`Partitioned Trace pending event limit exceeded for Run ${event.runId}.`));
			return;
		}

		if (event.type === "agent.run.finished") state.terminalAccepted = true;
		state.events.push(event);
		this.#acceptedEvents++;
		this.#pendingEvents++;
		state.queue = state.queue
			.then(async () => {
				if (state!.writeBlocked) return;
				state!.handle ??= await this.#openRun(state!);
				await state!.handle.write(line, undefined, "utf8");
				if (event.type === "agent.run.finished") await this.#finalize(state!);
			})
			.catch(async (error) => {
				this.#writeFailure(state, error);
				await this.#closeHandle(state);
			})
			.finally(() => {
				this.#pendingEvents--;
			});
	}

	async flush(): Promise<void> {
		const started = performance.now();
		try {
			await Promise.all([...this.#runs.values()].map(async (state) => await state.queue));
		} finally {
			this.#flushDurationMs = Math.max(0, performance.now() - started);
		}
	}

	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#disposed = true;
		this.#disposePromise = (async () => {
			await this.flush();
			for (const state of this.#runs.values()) {
				if (!state.completed) this.#markIncomplete(state);
				await this.#closeHandle(state);
			}
		})();
		return this.#disposePromise;
	}

	stats(): PartitionedTraceSinkStats {
		return Object.freeze({
			acceptedEvents: this.#acceptedEvents,
			droppedEvents: this.#droppedEvents,
			writeErrors: this.#writeErrors,
			openRunFiles: [...this.#runs.values()].filter((state) => !state.completed && !state.failed).length,
			completedRunFiles: this.#completedRunFiles,
			incompleteRunFiles: this.#incompleteRunFiles,
			flushDurationMs: this.#flushDurationMs,
		});
	}

	async completedTracePath(sessionId: string, runId: string): Promise<string | undefined> {
		validateTracePathId("sessionId", sessionId);
		validateTracePathId("runId", runId);
		const state = this.#runs.get(this.#key(sessionId, runId));
		if (!state?.completed) return undefined;
		try {
			await access(state.finalPath);
			return state.finalPath;
		} catch {
			return undefined;
		}
	}

	#createRunState(event: Extract<TraceEvent, { type: "agent.run.started" }>): PartitionedRunState {
		const sessionId = validateTracePathId("sessionId", event.sessionId);
		const runId = validateTracePathId("runId", event.runId);
		const day = new Date(event.timeUnixMs).toISOString().slice(0, 10);
		const directory = containedPath(this.#rootDir, day, `session_${sessionId}`);
		return {
			key: this.#key(sessionId, runId),
			sessionId,
			runId,
			partPath: containedPath(directory, `run_${runId}.jsonl.part`),
			finalPath: containedPath(directory, `run_${runId}.jsonl`),
			events: [],
			queue: Promise.resolve(),
			terminalAccepted: false,
			completed: false,
			failed: false,
			writeBlocked: false,
			incompleteCounted: false,
		};
	}

	async #openRun(state: PartitionedRunState): Promise<FileHandle> {
		await mkdir(dirname(state.partPath), { recursive: true });
		try {
			await access(state.finalPath);
			throw new Error(`Completed Trace already exists for Run ${state.runId}.`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		return await open(state.partPath, "wx");
	}

	async #finalize(state: PartitionedRunState): Promise<void> {
		const errors = validateRunTraceEvents(state.events);
		if (errors.length > 0) throw new Error(`Run Trace integrity validation failed: ${errors.join(" ")}`);
		if (this.#fsyncOnRunFinish) await state.handle?.sync();
		await this.#closeHandle(state);
		await rename(state.partPath, state.finalPath);
		state.completed = true;
		state.events.splice(0);
		this.#completedRunFiles++;
	}

	async #closeHandle(state: PartitionedRunState): Promise<void> {
		const handle = state.handle;
		state.handle = undefined;
		if (handle) {
			try { await handle.close(); } catch (error) { this.#writeFailure(state, error); }
		}
	}

	#drop(state: PartitionedRunState | undefined, error: Error): void {
		this.#droppedEvents++;
		if (state) {
			state.failed = true;
			this.#markIncomplete(state);
		}
		safeOnError(this.#onError, error);
	}

	#writeFailure(state: PartitionedRunState | undefined, cause: unknown): void {
		this.#writeErrors++;
		if (state) {
			state.failed = true;
			state.writeBlocked = true;
			this.#markIncomplete(state);
		}
		safeOnError(this.#onError, cause);
	}

	#markIncomplete(state: PartitionedRunState): void {
		if (state.incompleteCounted || state.completed) return;
		state.incompleteCounted = true;
		this.#incompleteRunFiles++;
	}

	#key(sessionId: string, runId: string): string {
		return `${sessionId}\u0000${runId}`;
	}
}

interface PendingNext {
	readonly resolve: (value: IteratorResult<TraceDelivery>) => void;
	readonly reject: (reason: unknown) => void;
}

function isToolEvent(event: TraceEvent): event is Extract<TraceEvent, { toolName: string }> {
	return event.type.startsWith("tool.");
}

function eventOutcome(event: TraceEvent): string | undefined {
	return event.type === "agent.run.finished" || event.type === "tool.call.finished" ? event.outcome : undefined;
}

function matchesFilter(event: TraceEvent, filter: TraceFilter | undefined): boolean {
	if (!filter) return true;
	if (filter.sessionIds && !filter.sessionIds.includes(event.sessionId)) return false;
	if (filter.runIds && !filter.runIds.includes(event.runId)) return false;
	if (filter.eventTypes && !filter.eventTypes.includes(event.type)) return false;
	if (filter.toolNames && (!isToolEvent(event) || !filter.toolNames.includes(event.toolName))) return false;
	const outcome = eventOutcome(event);
	if (filter.outcomes && (outcome === undefined || !filter.outcomes.includes(outcome as never))) return false;
	return true;
}

class TraceSubscriptionImpl implements TraceSubscription, AsyncIterator<TraceDelivery> {
	readonly id: string;
	readonly #filter: TraceFilter | undefined;
	readonly #capacity: number;
	readonly #overflow: "close" | "drop_oldest";
	readonly #onClose: (subscription: TraceSubscriptionImpl) => void;
	readonly #buffer: TraceRecord[] = [];
	readonly #pending: PendingNext[] = [];
	readonly #signal?: AbortSignal;
	readonly #abortListener?: () => void;
	#status: "open" | "closed" = "open";
	#closeReason?: string;
	#closeError?: Error;
	#pendingGap?: TraceGap;
	#deliveredEvents = 0;
	#filteredEvents = 0;
	#droppedEvents = 0;
	#lastDeliveredCursor?: string;

	constructor(
		id: string,
		options: TraceSubscriptionOptions,
		defaultCapacity: number,
		onClose: (subscription: TraceSubscriptionImpl) => void,
	) {
		this.id = id;
		this.#filter = options.filter;
		this.#capacity = validateCapacity("bufferCapacity", options.bufferCapacity ?? defaultCapacity);
		this.#overflow = options.overflow ?? "close";
		this.#onClose = onClose;
		this.#signal = options.signal;
		if (this.#signal) {
			this.#abortListener = () => this.close(this.#signal?.reason);
			if (this.#signal.aborted) this.close(this.#signal.reason);
			else this.#signal.addEventListener("abort", this.#abortListener, { once: true });
		}
	}

	get capacity(): number {
		return this.#capacity;
	}

	[Symbol.asyncIterator](): AsyncIterator<TraceDelivery> {
		return this;
	}

	next(): Promise<IteratorResult<TraceDelivery>> {
		if (this.#pendingGap) {
			const gap = this.#pendingGap;
			this.#pendingGap = undefined;
			return Promise.resolve({ done: false, value: gap });
		}
		const record = this.#buffer.shift();
		if (record) return Promise.resolve({ done: false, value: this.#markDelivered(record) });
		if (this.#status === "closed") {
			return this.#closeError ? Promise.reject(this.#closeError) : Promise.resolve({ done: true, value: undefined });
		}
		return new Promise((resolve, reject) => this.#pending.push({ resolve, reject }));
	}

	return(): Promise<IteratorResult<TraceDelivery>> {
		this.close("iterator_return");
		return Promise.resolve({ done: true, value: undefined });
	}

	accept(record: TraceRecord, replay = false): void {
		if (this.#status === "closed") return;
		if (!matchesFilter(record.event, this.#filter)) {
			this.#filteredEvents++;
			return;
		}
		const pending = this.#pending.shift();
		if (pending && !this.#pendingGap) {
			pending.resolve({ done: false, value: this.#markDelivered(record) });
			return;
		}
		if (this.#capacity === 0 || this.#buffer.length >= this.#capacity) {
			if (replay) throw new TraceReplayLimitError(this.#buffer.length + 1, this.#capacity);
			if (this.#overflow === "close") {
				this.#closeWithError(new TraceSubscriptionOverflowError(this.id));
				return;
			}
			const dropped = this.#buffer.shift();
			this.#droppedEvents++;
			this.#pendingGap = Object.freeze({
				kind: "gap",
				droppedCount: (this.#pendingGap?.droppedCount ?? 0) + 1,
				afterCursor: this.#lastDeliveredCursor,
				nextCursor: this.#buffer[0]?.cursor ?? record.cursor,
			});
			if (!dropped && this.#capacity === 0) return;
		}
		this.#buffer.push(record);
	}

	close(reason?: unknown): void {
		if (this.#status === "closed") return;
		this.#status = "closed";
		this.#closeReason = reason instanceof Error ? reason.message : reason === undefined ? undefined : String(reason);
		this.#buffer.splice(0);
		this.#pendingGap = undefined;
		this.#detach();
		for (const pending of this.#pending.splice(0)) pending.resolve({ done: true, value: undefined });
	}

	snapshot(): TraceSubscriptionSnapshot {
		return Object.freeze({
			id: this.id,
			status: this.#status,
			deliveredEvents: this.#deliveredEvents,
			filteredEvents: this.#filteredEvents,
			droppedEvents: this.#droppedEvents,
			...(this.#lastDeliveredCursor ? { lastDeliveredCursor: this.#lastDeliveredCursor } : {}),
			...(this.#closeReason ? { closeReason: this.#closeReason } : {}),
		});
	}

	#markDelivered(record: TraceRecord): TraceRecord {
		this.#deliveredEvents++;
		this.#lastDeliveredCursor = record.cursor;
		return record;
	}

	#closeWithError(error: Error): void {
		if (this.#status === "closed") return;
		this.#status = "closed";
		this.#closeReason = error.message;
		this.#closeError = error;
		this.#buffer.splice(0);
		this.#pendingGap = undefined;
		this.#detach();
		for (const pending of this.#pending.splice(0)) pending.reject(error);
	}

	#detach(): void {
		if (this.#signal && this.#abortListener) this.#signal.removeEventListener("abort", this.#abortListener);
		this.#onClose(this);
	}
}

export class TraceEventHub implements TraceSink, TraceSource {
	readonly #replayCapacity: number;
	readonly #defaultSubscriberBufferCapacity: number;
	readonly #sinks: readonly TraceSink[];
	readonly #ids: TraceIdGenerator;
	readonly #onError: TraceEventHubOptions["onError"];
	readonly #hubId: string;
	readonly #ring: TraceRecord[] = [];
	readonly #subscriptions = new Set<TraceSubscriptionImpl>();
	readonly #pendingEmits: TraceEvent[] = [];
	#offset = 0n;
	#emitting = false;
	#disposed = false;
	#disposePromise?: Promise<void>;

	constructor(options: TraceEventHubOptions = {}) {
		this.#replayCapacity = validateCapacity("replayCapacity", options.replayCapacity ?? 10_000);
		this.#defaultSubscriberBufferCapacity = validateCapacity(
			"defaultSubscriberBufferCapacity",
			options.defaultSubscriberBufferCapacity ?? 1_000,
		);
		this.#sinks = Object.freeze([...(options.sinks ?? [])]);
		this.#ids = options.idGenerator ?? new DefaultTraceIdGenerator();
		this.#onError = options.onError;
		this.#hubId = this.#ids.generate("hub");
	}

	emit(event: TraceEvent): void {
		if (this.#disposed) {
			safeOnError(this.#onError, new TraceHubStateError("TraceEventHub is disposed."));
			return;
		}
		this.#pendingEmits.push(event);
		if (this.#emitting) return;
		this.#emitting = true;
		try {
			while (this.#pendingEmits.length > 0) this.#emitOne(this.#pendingEmits.shift() as TraceEvent);
		} finally {
			this.#emitting = false;
		}
	}

	#emitOne(event: TraceEvent): void {
		const record = Object.freeze({ kind: "event" as const, cursor: this.#nextCursor(), event });
		if (this.#replayCapacity > 0) {
			this.#ring.push(record);
			if (this.#ring.length > this.#replayCapacity) this.#ring.shift();
		}
		for (const subscription of [...this.#subscriptions]) subscription.accept(record);
		for (const sink of this.#sinks) {
			try {
				sink.emit(event);
			} catch (error) {
				safeOnError(this.#onError, error);
			}
		}
	}

	subscribe(options: TraceSubscriptionOptions = {}): TraceSubscription {
		if (this.#disposed) throw new TraceHubStateError("Cannot subscribe to a disposed TraceEventHub.");
		const start = options.start ?? { mode: "latest" as const };
		const replay = this.#selectReplay(start);
		const subscription = new TraceSubscriptionImpl(
			this.#ids.generate("subscription"),
			options,
			this.#defaultSubscriberBufferCapacity,
			(value) => this.#subscriptions.delete(value),
		);
		if (subscription.snapshot().status === "closed") return subscription;
		const matchedReplayCount = replay.filter((record) => matchesFilter(record.event, options.filter)).length;
		if (matchedReplayCount > subscription.capacity) {
			throw new TraceReplayLimitError(matchedReplayCount, subscription.capacity);
		}
		for (const record of replay) subscription.accept(record, true);
		this.#subscriptions.add(subscription);
		return subscription;
	}

	async flush(): Promise<void> {
		const results = await Promise.allSettled(this.#sinks.map(async (sink) => await sink.flush?.()));
		this.#throwSinkErrors(results, "One or more Trace sinks failed to flush.");
	}

	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#disposed = true;
		for (const subscription of [...this.#subscriptions]) subscription.close("hub_disposed");
		this.#ring.splice(0);
		this.#disposePromise = (async () => {
			const results = await Promise.allSettled(
				this.#sinks.map(async (sink) => {
					await sink.flush?.();
					await sink.dispose?.();
				}),
			);
			this.#throwSinkErrors(results, "One or more Trace sinks failed to dispose.");
		})();
		return this.#disposePromise;
	}

	snapshot(): readonly TraceRecord[] {
		return Object.freeze([...this.#ring]);
	}

	get subscriberCount(): number {
		return this.#subscriptions.size;
	}

	#nextCursor(): string {
		this.#offset++;
		return `cur.${this.#hubId}.${this.#offset.toString(36)}`;
	}

	#parseCursor(cursor: string): bigint {
		const prefix = `cur.${this.#hubId}.`;
		if (!cursor.startsWith(prefix)) throw new InvalidTraceCursorError("Trace cursor belongs to another Hub.");
		const encoded = cursor.slice(prefix.length);
		if (!/^[0-9a-z]+$/.test(encoded)) throw new InvalidTraceCursorError();
		let value = 0n;
		for (const char of encoded) {
			const digit = BigInt(Number.parseInt(char, 36));
			value = value * 36n + digit;
		}
		if (value <= 0n || value > this.#offset) throw new InvalidTraceCursorError();
		return value;
	}

	#selectReplay(start: NonNullable<TraceSubscriptionOptions["start"]>): readonly TraceRecord[] {
		if (start.mode === "latest") return [];
		if (start.mode === "earliest_available") return [...this.#ring];
		const offset = this.#parseCursor(start.cursor);
		if (offset === this.#offset) return [];
		const earliest = this.#ring[0];
		const latest = this.#ring.at(-1);
		if (!earliest || !latest) throw new TraceCursorExpiredError(undefined, undefined);
		const earliestOffset = this.#parseCursor(earliest.cursor);
		if (offset < earliestOffset) throw new TraceCursorExpiredError(earliest.cursor, latest.cursor);
		const index = this.#ring.findIndex((record) => record.cursor === start.cursor);
		if (index < 0) throw new TraceCursorExpiredError(earliest.cursor, latest.cursor);
		return this.#ring.slice(index + 1);
	}

	#throwSinkErrors(results: readonly PromiseSettledResult<unknown>[], message: string): void {
		const errors = results.flatMap((result) => (result.status === "rejected" ? [toError(result.reason)] : []));
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, message);
	}
}
