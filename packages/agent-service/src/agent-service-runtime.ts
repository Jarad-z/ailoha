import { randomUUID } from "node:crypto";
import {
	AgentStateError,
	AgentTurnLimitError,
	MessageAdmissionError,
	SessionRuntime,
	TraceEventHub,
	isAbortError,
} from "@ailoha/agent-core";
import type { ManagedSession, RunResult, RunTraceStore, SessionOptions, TraceSubscription } from "@ailoha/agent-core";
import { InMemoryServiceEventPublisher } from "./event-publisher.js";
import { AgentServiceError, mapServiceError, serviceFailure } from "./errors.js";
import { InMemoryAgentProfileRegistry } from "./profile-registry.js";
import { InMemoryTranscriptStore } from "./transcript-store.js";
import { createAgentServiceTrace } from "./trace-config.js";
import type {
	AgentProfile,
	AgentServiceRuntimeOptions,
	CompactSessionInput,
	CompactSessionResult,
	CreateAgentProfileInput,
	CreateServiceSessionInput,
	MessageDelivery,
	MessagePage,
	OperationInfo,
	OperationStatus,
	OperationType,
	RunInfo,
	RunStatus,
	SendMessageInput,
	SendMessageResult,
	SendRunMessageInput,
	ServiceError,
	ServiceEvent,
	ServiceEventPublisher,
	ServiceEventSubscription,
	ServiceMessage,
	ServiceRequestContext,
	ServiceSessionInfo,
	ServiceSessionStatus,
	TranscriptStore,
	UpdateAgentProfileInput,
} from "./types.js";

interface MutableServiceSession {
	id: string;
	ownerId: string;
	agentProfileId: string;
	workspaceId?: string;
	title?: string;
	status: ServiceSessionStatus;
	activeRunId?: string;
	activeOperationId?: string;
	createdAt: number;
	updatedAt: number;
	handle?: ManagedSession;
}

interface MutableRun {
	id: string;
	sessionId: string;
	status: RunStatus;
	startedAt: number;
	finishedAt?: number;
	error?: ServiceError;
}

interface MutableOperation {
	id: string;
	ownerId: string;
	type: OperationType;
	sessionId?: string;
	runId?: string;
	status: OperationStatus;
	createdAt: number;
	finishedAt?: number;
	result?: unknown;
	error?: ServiceError;
}

interface IdempotencyRecord {
	readonly fingerprint: string;
	readonly operationId: string;
	readonly expiresAt: number;
	readonly promise: Promise<unknown>;
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (value && typeof value === "object") {
		const output: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			output[key] = stableValue((value as Record<string, unknown>)[key]);
		}
		return output;
	}
	return value;
}

function fingerprint(value: unknown): string {
	return JSON.stringify(stableValue(value));
}

function cloneAndFreeze(value: unknown): unknown {
	if (Array.isArray(value)) return Object.freeze(value.map(cloneAndFreeze));
	if (value && typeof value === "object") {
		const output: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) output[key] = cloneAndFreeze(child);
		return Object.freeze(output);
	}
	return value;
}

function operationSnapshot(record: MutableOperation): OperationInfo {
	return Object.freeze({
		id: record.id,
		type: record.type,
		...(record.sessionId ? { sessionId: record.sessionId } : {}),
		...(record.runId ? { runId: record.runId } : {}),
		status: record.status,
		createdAt: record.createdAt,
		...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
		...(record.result === undefined ? {} : { result: record.result }),
		...(record.error ? { error: record.error } : {}),
	});
}

function runSnapshot(record: MutableRun): RunInfo {
	return Object.freeze({ ...record });
}

export class AgentServiceRuntime {
	readonly #sessionRuntime: SessionRuntime;
	readonly #profiles: NonNullable<AgentServiceRuntimeOptions["profileRegistry"]>;
	readonly #resolveSessionOptions: AgentServiceRuntimeOptions["resolveSessionOptions"];
	readonly #traceHub: TraceEventHub;
	readonly #traceStore?: RunTraceStore;
	readonly #ownsTraceHub: boolean;
	readonly #events: ServiceEventPublisher;
	readonly #transcript: TranscriptStore;
	readonly #generateId: NonNullable<AgentServiceRuntimeOptions["generateId"]>;
	readonly #clock: () => number;
	readonly #idempotencyTtlMs: number;
	readonly #traceCapture: AgentServiceRuntimeOptions["traceCapture"];
	readonly #traceLevel?: import("@ailoha/agent-core").TraceLevel;
	readonly #sessions = new Map<string, MutableServiceSession>();
	readonly #runs = new Map<string, MutableRun>();
	readonly #operations = new Map<string, MutableOperation>();
	readonly #operationPromises = new Map<string, Promise<unknown>>();
	readonly #idempotency = new Map<string, IdempotencyRecord>();
	#status: "open" | "disposing" | "disposed" = "open";
	#disposePromise?: Promise<void>;

	constructor(options: AgentServiceRuntimeOptions) {
		if (options.traceConfig && (options.traceHub || options.traceStore || options.traceCapture)) {
			throw new TypeError("traceConfig cannot be combined with traceHub, traceStore, or traceCapture.");
		}
		const configuredTrace = options.traceConfig ? createAgentServiceTrace(options.traceConfig) : undefined;
		this.#clock = options.clock ?? Date.now;
		this.#generateId = options.generateId ?? ((kind) => `${kind}_${randomUUID()}`);
		this.#sessionRuntime = options.sessionRuntime ?? new SessionRuntime();
		this.#profiles =
			options.profileRegistry ??
			new InMemoryAgentProfileRegistry({
				clock: this.#clock,
				generateId: () => this.#generateId("profile"),
			});
		this.#resolveSessionOptions = options.resolveSessionOptions;
		this.#traceHub = configuredTrace?.traceHub ?? options.traceHub ?? new TraceEventHub();
		this.#traceStore = configuredTrace?.traceStore ?? options.traceStore;
		this.#traceCapture = configuredTrace?.capture ?? options.traceCapture;
		this.#traceLevel = configuredTrace?.level;
		this.#ownsTraceHub = configuredTrace !== undefined || options.traceHub === undefined;
		this.#events = options.eventPublisher ?? new InMemoryServiceEventPublisher({ replayCapacity: options.eventReplayCapacity });
		this.#transcript = options.transcriptStore ?? new InMemoryTranscriptStore();
		this.#idempotencyTtlMs = options.idempotencyTtlMs ?? 24 * 60 * 60 * 1_000;
		if (!Number.isFinite(this.#idempotencyTtlMs) || this.#idempotencyTtlMs < 0) {
			throw new RangeError("idempotencyTtlMs must be a non-negative finite number.");
		}
	}

	get status(): "open" | "disposing" | "disposed" {
		return this.#status;
	}

	async createAgentProfile(input: CreateAgentProfileInput): Promise<AgentProfile> {
		this.#assertOpen();
		return this.#profiles.create(input);
	}

	getAgentProfile(id: string): Promise<AgentProfile | undefined> {
		return this.#profiles.get(id);
	}

	listAgentProfiles(): Promise<readonly AgentProfile[]> {
		return this.#profiles.list();
	}

	async updateAgentProfile(id: string, patch: UpdateAgentProfileInput): Promise<AgentProfile> {
		this.#assertOpen();
		return this.#profiles.update(id, patch);
	}

	async deleteAgentProfile(id: string): Promise<boolean> {
		this.#assertOpen();
		return this.#profiles.delete(id);
	}

	async createSession(input: CreateServiceSessionInput, context: ServiceRequestContext): Promise<ServiceSessionInfo> {
		this.#assertOwner(context);
		this.#assertOpen();
		return this.#executeIdempotent(
			context.ownerId,
			"session.create",
			input.idempotencyKey,
			input,
			undefined,
			async (operation) => {
				const profile = await this.#profiles.get(input.agentProfileId);
				if (!profile) throw serviceFailure("not_found", "Agent Profile was not found.", 404);
				const sessionId = this.#generateId("session");
				const now = this.#clock();
				const record: MutableServiceSession = {
					id: sessionId,
					ownerId: context.ownerId,
					agentProfileId: profile.id,
					...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
					...(input.title === undefined ? {} : { title: input.title }),
					status: "creating",
					activeOperationId: operation.id,
					createdAt: now,
					updatedAt: now,
				};
				operation.sessionId = sessionId;
				operation.status = "running";
				this.#sessions.set(sessionId, record);
				this.#publish("session.creating", record, operation.id);
				try {
					const resolved = await this.#resolveSessionOptions(profile, {
						ownerId: context.ownerId,
						sessionId,
						...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
					});
					const sessionOptions: SessionOptions = {
						...resolved,
						trace: {
							sink: this.#traceHub,
							sinkOwnership: "external",
							capture: this.#traceCapture,
							level: this.#traceLevel,
						},
					};
					const handle = await this.#sessionRuntime.createSession({ id: sessionId, session: sessionOptions });
					record.handle = handle;
					record.status = "ready";
					record.activeOperationId = undefined;
					record.updatedAt = this.#clock();
					const result = this.#sessionSnapshot(record);
					this.#succeedOperation(operation, result);
					this.#publish("session.ready", record, operation.id);
					return result;
				} catch (cause) {
					record.status = "closed";
					record.activeOperationId = undefined;
					record.updatedAt = this.#clock();
					throw cause;
				}
			},
		);
	}

	async getSession(sessionId: string, context: ServiceRequestContext): Promise<ServiceSessionInfo | undefined> {
		this.#assertOwner(context);
		const record = this.#sessions.get(sessionId);
		if (!record) return undefined;
		this.#assertAccess(record, context.ownerId);
		return this.#sessionSnapshot(record);
	}

	async listSessions(context: ServiceRequestContext): Promise<readonly ServiceSessionInfo[]> {
		this.#assertOwner(context);
		return Promise.resolve(
			Object.freeze(
				[...this.#sessions.values()]
					.filter((record) => record.ownerId === context.ownerId)
					.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
					.map((record) => this.#sessionSnapshot(record)),
			),
		);
	}

	async updateSession(
		sessionId: string,
		patch: { readonly title?: string },
		context: ServiceRequestContext,
	): Promise<ServiceSessionInfo> {
		this.#assertOpen();
		const record = this.#ownedSession(sessionId, context.ownerId);
		if (record.status === "closed") throw serviceFailure("not_found", "Session was not found.", 404);
		record.title = patch.title;
		record.updatedAt = this.#clock();
		return Promise.resolve(this.#sessionSnapshot(record));
	}

	async closeSession(sessionId: string, idempotencyKey: string, context: ServiceRequestContext): Promise<void> {
		this.#assertOpen();
		const record = this.#ownedSession(sessionId, context.ownerId);
		return this.#executeIdempotent(
			context.ownerId,
			"session.close",
			idempotencyKey,
			{ sessionId },
			sessionId,
			async (operation) => {
				if (record.status === "closed") {
					this.#succeedOperation(operation);
					return;
				}
				record.status = "closing";
				record.activeOperationId = operation.id;
				record.updatedAt = this.#clock();
				operation.status = "running";
				await this.#sessionRuntime.disposeSession(sessionId);
				record.status = "closed";
				record.activeRunId = undefined;
				record.activeOperationId = undefined;
				record.updatedAt = this.#clock();
				this.#succeedOperation(operation);
				this.#publish("session.closed", record, operation.id);
			},
		);
	}

	async sendMessage(input: SendMessageInput, context: ServiceRequestContext): Promise<SendMessageResult> {
		this.#assertOpen();
		const session = this.#ownedReadySession(input.sessionId, context.ownerId);
		return this.#executeIdempotent(
			context.ownerId,
			"message.send",
			input.idempotencyKey,
			input,
			input.sessionId,
			(operation) => this.#admitMessage(session, input, operation),
		);
	}

	async sendRunMessage(input: SendRunMessageInput, context: ServiceRequestContext): Promise<SendMessageResult> {
		this.#assertOpen();
		const run = this.#runs.get(input.runId);
		if (!run) return Promise.reject(serviceFailure("not_found", "Run was not found.", 404));
		const session = this.#ownedReadySession(run.sessionId, context.ownerId);
		return this.#executeIdempotent(
			context.ownerId,
			"message.send",
			input.idempotencyKey,
			input,
			run.sessionId,
			(operation) => {
				if (session.activeRunId !== input.runId || run.status !== "running") {
					throw serviceFailure("run_not_active", "The target Run is not active.", 409);
				}
				return this.#admitMessage(
					session,
					{
						sessionId: run.sessionId,
						message: input.message,
						delivery: input.delivery,
						idempotencyKey: input.idempotencyKey,
					},
					operation,
				);
			},
		);
	}

	async getRun(runId: string, context: ServiceRequestContext): Promise<RunInfo | undefined> {
		const run = this.#runs.get(runId);
		if (!run) return Promise.resolve(undefined);
		this.#ownedSession(run.sessionId, context.ownerId);
		return Promise.resolve(runSnapshot(run));
	}

	async listRuns(sessionId: string, context: ServiceRequestContext): Promise<readonly RunInfo[]> {
		this.#ownedSession(sessionId, context.ownerId);
		return Promise.resolve(
			Object.freeze(
				[...this.#runs.values()]
					.filter((run) => run.sessionId === sessionId)
					.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
					.map(runSnapshot),
			),
		);
	}

	async getRunTracePath(runId: string, context: ServiceRequestContext): Promise<string> {
		const run = this.#runs.get(runId);
		if (!run) throw serviceFailure("not_found", "Run was not found.", 404);
		this.#ownedSession(run.sessionId, context.ownerId);
		if (run.status === "running") throw serviceFailure("run_not_finished", "The Run is not finished.", 409, true);
		await this.#traceHub.flush();
		const path = await this.#traceStore?.completedTracePath(run.sessionId, run.id);
		if (!path) throw serviceFailure("trace_not_found", "The completed Run Trace was not found.", 404);
		return path;
	}

	async abortRun(
		sessionId: string,
		runId: string,
		idempotencyKey: string,
		context: ServiceRequestContext,
	): Promise<OperationInfo> {
		this.#assertOpen();
		const session = this.#ownedReadySession(sessionId, context.ownerId);
		return this.#executeIdempotent(
			context.ownerId,
			"run.abort",
			idempotencyKey,
			{ sessionId, runId },
			sessionId,
			(operation) => {
				operation.runId = runId;
				if (session.activeRunId === runId) session.handle?.agent.abort();
				this.#succeedOperation(operation, { activeRunMatched: session.activeRunId === runId });
				return operationSnapshot(operation);
			},
		);
	}

	async compactSession(input: CompactSessionInput, context: ServiceRequestContext): Promise<CompactSessionResult> {
		this.#assertOpen();
		const session = this.#ownedReadySession(input.sessionId, context.ownerId);
		return this.#executeIdempotent(
			context.ownerId,
			"session.compact",
			input.idempotencyKey,
			{ sessionId: input.sessionId },
			input.sessionId,
			(operation) => {
				if (session.handle?.agent.state.status !== "idle") {
					throw serviceFailure("session_not_idle", "Manual compact requires an idle Session.", 409);
				}
				operation.status = "running";
				session.activeOperationId = operation.id;
				session.updatedAt = this.#clock();
				const compactPromise = session.handle!.agent.compact({ signal: input.signal });
				this.#publish("compact.started", session, operation.id);
				void compactPromise.then(
					(result) => {
						this.#succeedOperation(operation, result);
						session.activeOperationId = undefined;
						session.updatedAt = this.#clock();
						this.#publish("compact.succeeded", session, operation.id, undefined, result);
					},
					(cause) => {
						const error = mapServiceError(cause);
						this.#failOperation(operation, error, isAbortError(cause) ? "aborted" : "failed");
						session.activeOperationId = undefined;
						session.updatedAt = this.#clock();
						this.#publish(isAbortError(cause) ? "compact.aborted" : "compact.failed", session, operation.id, undefined, {
							error: error.serviceError,
						});
					},
				);
				return { operationId: operation.id, sessionId: session.id, status: "running" };
			},
		);
	}

	async getOperation(operationId: string, context: ServiceRequestContext): Promise<OperationInfo | undefined> {
		const operation = this.#operations.get(operationId);
		if (!operation) return Promise.resolve(undefined);
		if (operation.ownerId !== context.ownerId) throw serviceFailure("forbidden", "Access to this resource is forbidden.", 403);
		return Promise.resolve(operationSnapshot(operation));
	}

	async listMessages(sessionId: string, cursor: string | undefined, context: ServiceRequestContext): Promise<MessagePage> {
		this.#ownedSession(sessionId, context.ownerId);
		return Promise.resolve(this.#transcript.list(sessionId, cursor));
	}

	subscribeSessionEvents(
		sessionId: string,
		cursor: string | undefined,
		context: ServiceRequestContext,
	): ServiceEventSubscription {
		this.#ownedSession(sessionId, context.ownerId);
		return this.#events.subscribe(sessionId, cursor);
	}

	subscribeSessionTrace(
		sessionId: string,
		cursor: string | undefined,
		context: ServiceRequestContext,
	): TraceSubscription {
		this.#ownedSession(sessionId, context.ownerId);
		return this.#traceHub.subscribe({
			start: cursor ? { mode: "after", cursor } : { mode: "latest" },
			filter: { sessionIds: [sessionId] },
		});
	}

	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#status = "disposing";
		this.#events.dispose();
		this.#disposePromise = (async () => {
			const results = await Promise.allSettled([
				this.#sessionRuntime.dispose(),
				...(this.#ownsTraceHub ? [this.#traceHub.dispose()] : []),
			]);
			this.#status = "disposed";
			const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
			if (errors.length > 0) throw new AggregateError(errors, "Agent Service Runtime disposal failed.");
		})();
		return this.#disposePromise;
	}

	#admitMessage(
		session: MutableServiceSession,
		input: SendMessageInput,
		operation: MutableOperation,
	): SendMessageResult | Promise<SendMessageResult> {
		const agent = session.handle!.agent;
		if (agent.state.status === "compacting") {
			throw serviceFailure("agent_compacting", "The Agent is compacting its context.", 409);
		}
		const delivery = input.delivery ?? "auto";
		const acceptedAs: Exclude<MessageDelivery, "auto"> =
			delivery === "auto" ? (agent.state.status === "idle" ? "prompt" : "follow_up") : delivery;

		if (agent.state.status === "idle" && (acceptedAs === "steer" || acceptedAs === "follow_up")) {
			throw serviceFailure("agent_not_running", "The Agent is not running.", 409);
		}
		if (agent.state.status === "running" && acceptedAs === "prompt") {
			throw serviceFailure("agent_already_running", "The Agent is already running.", 409);
		}

		const messageId = this.#generateId("message");
		let runId = session.activeRunId;
		let promptPromise: Promise<RunResult> | undefined;
		if (acceptedAs === "prompt") {
			runId = this.#generateId("run");
			const run: MutableRun = { id: runId, sessionId: session.id, status: "running", startedAt: this.#clock() };
			this.#runs.set(runId, run);
			operation.runId = runId;
			promptPromise = agent.prompt(input.message, { runId, correlationId: operation.id });
			if (agent.state.status !== "running") {
				this.#runs.delete(runId);
				return promptPromise.then(
					() => {
						throw serviceFailure("operation_failed", "Prompt admission entered an invalid state.", 500);
					},
					(cause) => {
						throw mapServiceError(cause);
					},
				);
			}
			session.activeRunId = runId;
			session.activeOperationId = operation.id;
			session.updatedAt = this.#clock();
			this.#publish("run.started", session, operation.id, runId);
		} else {
			if (!runId) throw serviceFailure("run_not_active", "The Session has no active Run.", 409);
			operation.runId = runId;
			try {
				if (acceptedAs === "steer") agent.steer(input.message, { operationId: operation.id });
				else agent.followUp(input.message, { operationId: operation.id });
			} catch (cause) {
				throw mapServiceError(cause);
			}
		}

		const message: ServiceMessage = Object.freeze({
			id: messageId,
			sessionId: session.id,
			runId,
			role: "user",
			content: cloneAndFreeze(input.message.content),
			delivery: acceptedAs,
			createdAt: this.#clock(),
		});
		this.#appendMessage(message);
		const result: SendMessageResult = Object.freeze({
			operationId: operation.id,
			messageId,
			sessionId: session.id,
			runId,
			acceptedAs,
			runStatus: "running",
		});
		this.#succeedOperation(operation, result);
		this.#publish("message.accepted", session, operation.id, runId, { messageId, acceptedAs });
		if (promptPromise) this.#observeRun(session, this.#runs.get(runId)!, promptPromise);
		return result;
	}

	#observeRun(session: MutableServiceSession, run: MutableRun, promise: Promise<RunResult>): void {
		void promise.then(
			(result) => {
				run.status = "succeeded";
				run.finishedAt = this.#clock();
				if (result.finalAssistantMessage) {
					this.#appendMessage(
						Object.freeze({
							id: this.#generateId("message"),
							sessionId: session.id,
							runId: run.id,
							role: "assistant",
							content: cloneAndFreeze(result.finalAssistantMessage.content),
							createdAt: this.#clock(),
						}),
					);
				}
				this.#finishRunCommit(session, run, "run.succeeded");
			},
			(cause) => {
				const error = mapServiceError(cause);
				run.status = isAbortError(cause) ? "aborted" : "failed";
				run.error = error.serviceError;
				run.finishedAt = this.#clock();
				this.#finishRunCommit(session, run, isAbortError(cause) ? "run.aborted" : "run.failed");
			},
		);
	}

	#finishRunCommit(
		session: MutableServiceSession,
		run: MutableRun,
		eventType: "run.succeeded" | "run.failed" | "run.aborted",
	): void {
		if (session.activeRunId === run.id) {
			session.activeRunId = undefined;
			session.activeOperationId = undefined;
			session.updatedAt = this.#clock();
		}
		this.#publish(eventType, session, undefined, run.id, run.error ? { error: run.error } : undefined);
	}

	#executeIdempotent<T>(
		ownerId: string,
		type: OperationType,
		key: string,
		payload: unknown,
		sessionId: string | undefined,
		action: (operation: MutableOperation) => T | Promise<T>,
	): Promise<T> {
		if (typeof key !== "string" || key.trim() === "") {
			return Promise.reject(serviceFailure("invalid_request", "Idempotency-Key is required.", 400));
		}
		this.#pruneIdempotency();
		const composite = `${ownerId}\u0000${type}\u0000${key}`;
		const bodyFingerprint = fingerprint(payload);
		const existing = this.#idempotency.get(composite);
		if (existing) {
			if (existing.fingerprint !== bodyFingerprint) {
				return Promise.reject(
					serviceFailure("idempotency_key_reused", "Idempotency-Key was reused with a different request.", 409),
				);
			}
			return existing.promise as Promise<T>;
		}

		const operation: MutableOperation = {
			id: this.#generateId("operation"),
			ownerId,
			type,
			...(sessionId ? { sessionId } : {}),
			status: "accepted",
			createdAt: this.#clock(),
		};
		this.#operations.set(operation.id, operation);
		let resolve!: (value: T | PromiseLike<T>) => void;
		let reject!: (reason?: unknown) => void;
		const promise = new Promise<T>((resolvePromise, rejectPromise) => {
			resolve = resolvePromise;
			reject = rejectPromise;
		});
		this.#operationPromises.set(operation.id, promise);
		this.#idempotency.set(composite, {
			fingerprint: bodyFingerprint,
			operationId: operation.id,
			expiresAt: this.#clock() + this.#idempotencyTtlMs,
			promise,
		});
		try {
			resolve(action(operation));
		} catch (cause) {
			const error = mapServiceError(cause);
			this.#failOperation(operation, error, isAbortError(cause) ? "aborted" : "failed");
			reject(error);
		}
		void promise.catch((cause) => {
			if (operation.status !== "failed" && operation.status !== "aborted") {
				const error = mapServiceError(cause);
				this.#failOperation(operation, error, isAbortError(cause) ? "aborted" : "failed");
			}
		});
		return promise;
	}

	#succeedOperation(operation: MutableOperation, result?: unknown): void {
		operation.status = "succeeded";
		operation.finishedAt = this.#clock();
		operation.result = result;
	}

	#failOperation(operation: MutableOperation, error: AgentServiceError, status: "failed" | "aborted"): void {
		operation.status = status;
		operation.finishedAt = this.#clock();
		operation.error = error.serviceError;
	}

	#appendMessage(message: ServiceMessage): void {
		this.#transcript.append(message);
	}

	#publish(
		type: ServiceEvent["type"],
		session: MutableServiceSession,
		operationId?: string,
		runId?: string,
		data?: unknown,
	): void {
		if (this.#status !== "open") return;
		this.#events.publish(
			Object.freeze({
				id: this.#generateId("event"),
				type,
				timeUnixMs: this.#clock(),
				ownerId: session.ownerId,
				sessionId: session.id,
				...(operationId ? { operationId } : {}),
				...(runId ? { runId } : {}),
				...(data === undefined ? {} : { data }),
			}),
		);
	}

	#sessionSnapshot(record: MutableServiceSession): ServiceSessionInfo {
		return Object.freeze({
			id: record.id,
			ownerId: record.ownerId,
			agentProfileId: record.agentProfileId,
			...(record.workspaceId === undefined ? {} : { workspaceId: record.workspaceId }),
			...(record.handle && record.status !== "closed" ? { workspace: record.handle.workspace } : {}),
			...(record.title === undefined ? {} : { title: record.title }),
			status: record.status,
			...(record.handle && record.status !== "closed" ? { agentStatus: record.handle.agent.state.status } : {}),
			...(record.activeRunId ? { activeRunId: record.activeRunId } : {}),
			...(record.activeOperationId ? { activeOperationId: record.activeOperationId } : {}),
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
		});
	}

	#ownedSession(sessionId: string, ownerId: string): MutableServiceSession {
		const record = this.#sessions.get(sessionId);
		if (!record) throw serviceFailure("not_found", "Session was not found.", 404);
		this.#assertAccess(record, ownerId);
		return record;
	}

	#ownedReadySession(sessionId: string, ownerId: string): MutableServiceSession {
		const record = this.#ownedSession(sessionId, ownerId);
		if (record.status !== "ready" || !record.handle) {
			throw serviceFailure("session_not_ready", "Session is not ready.", 409, record.status === "creating");
		}
		return record;
	}

	#assertAccess(record: MutableServiceSession, ownerId: string): void {
		if (record.ownerId !== ownerId) throw serviceFailure("forbidden", "Access to this Session is forbidden.", 403);
	}

	#assertOwner(context: ServiceRequestContext): void {
		if (!context.ownerId || context.ownerId.trim() === "") throw serviceFailure("unauthenticated", "Authentication is required.", 401);
	}

	#assertOpen(): void {
		if (this.#status !== "open") throw serviceFailure("runtime_unavailable", "The Agent Service Runtime is unavailable.", 503, true);
	}

	#pruneIdempotency(): void {
		const now = this.#clock();
		for (const [key, record] of this.#idempotency) {
			if (record.expiresAt <= now) this.#idempotency.delete(key);
		}
	}
}
