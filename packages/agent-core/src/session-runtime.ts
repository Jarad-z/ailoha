import { Agent } from "./agent.js";
import {
	DuplicateSessionIdError,
	SessionCapacityError,
	SessionRuntimeStateError,
	createAbortError,
	toError,
} from "./errors.js";
import { createSessionId, validateSessionId } from "./session-id.js";
import { Session } from "./session.js";
import type { SessionOptions } from "./session.js";
import type { AgentStatus, SessionId, SessionWorkspace } from "./types.js";

export type SessionRuntimeStatus = "open" | "disposing" | "disposed";
export type ManagedSessionStatus = "creating" | "ready" | "disposing" | "disposed";

export interface SessionCreationContext {
	readonly id: SessionId;
	readonly signal: AbortSignal;
}

export interface CreateManagedSessionOptions {
	readonly id?: SessionId;
	readonly session: SessionOptions;
	readonly signal?: AbortSignal;
}

export interface SessionRuntimeOptions {
	readonly generateSessionId?: () => SessionId;
	readonly maxSessions?: number;
	readonly createSession?: (
		options: SessionOptions,
		context: SessionCreationContext,
	) => Promise<Session>;
}

export interface ManagedSessionInfo {
	readonly id: SessionId;
	readonly workspace?: SessionWorkspace;
	readonly status: ManagedSessionStatus;
	readonly createdAt: number;
	readonly readyAt?: number;
	readonly agentStatus?: AgentStatus;
}

export interface ManagedSession {
	readonly id: SessionId;
	readonly workspace: SessionWorkspace;
	readonly agent: Agent;
	readonly createdAt: number;
	readonly readyAt: number;
	dispose(): Promise<void>;
	snapshot(): ManagedSessionInfo;
}

interface SessionRecord {
	readonly id: SessionId;
	readonly createdAt: number;
	readonly createController: AbortController;
	readonly removeAbortListeners: () => void;
	status: ManagedSessionStatus;
	createPromise: Promise<ManagedSession>;
	session?: Session;
	handle?: ManagedSessionHandle;
	readyAt?: number;
	disposePromise?: Promise<void>;
	cleanupError?: Error;
}

function snapshotRecord(record: SessionRecord): ManagedSessionInfo {
	const snapshot: ManagedSessionInfo = {
		id: record.id,
		...(record.session ? { workspace: record.session.workspace } : {}),
		status: record.status,
		createdAt: record.createdAt,
		...(record.readyAt === undefined ? {} : { readyAt: record.readyAt }),
		...(record.status === "ready" && record.session ? { agentStatus: record.session.agent.state.status } : {}),
	};
	return Object.freeze(snapshot);
}

class ManagedSessionHandle implements ManagedSession {
	readonly id: SessionId;
	readonly workspace: SessionWorkspace;
	readonly agent: Agent;
	readonly createdAt: number;
	readonly readyAt: number;
	readonly #record: SessionRecord;
	readonly #disposeRecord: (record: SessionRecord) => Promise<void>;

	constructor(record: SessionRecord, disposeRecord: (record: SessionRecord) => Promise<void>) {
		if (!record.session || record.readyAt === undefined) throw new Error("Cannot create a handle before Session is ready.");
		this.id = record.id;
		this.workspace = record.session.workspace;
		this.agent = record.session.agent;
		this.createdAt = record.createdAt;
		this.readyAt = record.readyAt;
		this.#record = record;
		this.#disposeRecord = disposeRecord;
	}

	dispose(): Promise<void> {
		return this.#disposeRecord(this.#record);
	}

	snapshot(): ManagedSessionInfo {
		return snapshotRecord(this.#record);
	}
}

function linkAbortSignal(source: AbortSignal | undefined, target: AbortController): () => void {
	if (!source) return () => undefined;
	const forward = () => {
		if (!target.signal.aborted) target.abort(source.reason ?? createAbortError());
	};
	if (source.aborted) {
		forward();
		return () => undefined;
	}
	source.addEventListener("abort", forward, { once: true });
	return () => source.removeEventListener("abort", forward);
}

export class SessionRuntime {
	readonly #records = new Map<SessionId, SessionRecord>();
	readonly #ownedSessions = new WeakMap<Session, SessionId>();
	readonly #lifetimeController = new AbortController();
	readonly #generateSessionId: () => SessionId;
	readonly #maxSessions: number;
	readonly #createSession: NonNullable<SessionRuntimeOptions["createSession"]>;
	#status: SessionRuntimeStatus = "open";
	#disposePromise?: Promise<void>;

	constructor(options: SessionRuntimeOptions = {}) {
		const maxSessions = options.maxSessions ?? Number.POSITIVE_INFINITY;
		if (
			maxSessions !== Number.POSITIVE_INFINITY &&
			(!Number.isInteger(maxSessions) || maxSessions < 0)
		) {
			throw new RangeError("maxSessions must be a non-negative integer or Infinity.");
		}
		this.#generateSessionId = options.generateSessionId ?? createSessionId;
		this.#maxSessions = maxSessions;
		this.#createSession =
			options.createSession ??
			(async (sessionOptions, context) =>
				await Session.create(sessionOptions, { id: context.id, signal: context.signal }));
	}

	get status(): SessionRuntimeStatus {
		return this.#status;
	}

	createSession(options: CreateManagedSessionOptions): Promise<ManagedSession> {
		if (this.#status !== "open") {
			return Promise.reject(new SessionRuntimeStateError(`Cannot create a Session while Runtime is ${this.#status}.`));
		}

		let id: SessionId;
		try {
			id = validateSessionId(options.id ?? this.#generateSessionId());
			options.signal?.throwIfAborted();
		} catch (error) {
			return Promise.reject(error);
		}
		if (this.#records.has(id)) return Promise.reject(new DuplicateSessionIdError(id));
		if (this.#records.size >= this.#maxSessions) {
			return Promise.reject(new SessionCapacityError(this.#maxSessions));
		}

		const createController = new AbortController();
		const removeCallerAbort = linkAbortSignal(options.signal, createController);
		const removeRuntimeAbort = linkAbortSignal(this.#lifetimeController.signal, createController);
		const record: SessionRecord = {
			id,
			createdAt: Date.now(),
			createController,
			removeAbortListeners() {
				removeCallerAbort();
				removeRuntimeAbort();
			},
			status: "creating",
			createPromise: undefined as unknown as Promise<ManagedSession>,
		};

		this.#records.set(id, record);
		record.createPromise = this.#finishCreate(record, options.session);
		return record.createPromise;
	}

	getSession(id: SessionId): ManagedSession | undefined {
		const record = this.#records.get(id);
		return record?.status === "ready" ? record.handle : undefined;
	}

	listSessions(): readonly ManagedSessionInfo[] {
		const snapshots = [...this.#records.values()]
			.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
			.map(snapshotRecord);
		return Object.freeze(snapshots);
	}

	disposeSession(id: SessionId): Promise<boolean> {
		const record = this.#records.get(id);
		if (!record) return Promise.resolve(false);
		return this.#disposeRecord(record).then(() => true);
	}

	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#status = "disposing";
		this.#lifetimeController.abort(createAbortError("Session Runtime disposed."));
		const records = [...this.#records.values()].sort((left, right) => left.id.localeCompare(right.id));
		const disposals = records.map((record) => this.#disposeRecord(record));

		this.#disposePromise = (async () => {
			const results = await Promise.allSettled(disposals);
			this.#records.clear();
			this.#status = "disposed";
			const errors = results.flatMap((result) => (result.status === "rejected" ? [toError(result.reason)] : []));
			if (errors.length > 0) throw new AggregateError(errors, "One or more Sessions failed to dispose.");
		})();
		return this.#disposePromise;
	}

	async #finishCreate(record: SessionRecord, options: SessionOptions): Promise<ManagedSession> {
		let session: Session | undefined;
		let ownedByAnotherRecord = false;
		try {
			record.createController.signal.throwIfAborted();
			session = await this.#createSession(options, {
				id: record.id,
				signal: record.createController.signal,
			});

			if (!(session instanceof Session)) {
				throw new SessionRuntimeStateError("Session factory returned an invalid Session object.");
			}
			if (session.sessionId !== record.id) {
				throw new SessionRuntimeStateError(
					`Session factory returned ID ${session.sessionId}; expected ${record.id}.`,
				);
			}
			const currentOwner = this.#ownedSessions.get(session);
			if (currentOwner !== undefined) {
				ownedByAnotherRecord = true;
				throw new SessionRuntimeStateError(
					`Session object is already owned by record ${currentOwner}.`,
				);
			}

			record.createController.signal.throwIfAborted();
			if (this.#status !== "open" || record.status !== "creating") {
				throw createAbortError("Session creation was cancelled before publication.");
			}

			this.#ownedSessions.set(session, record.id);
			record.session = session;
			record.readyAt = Date.now();
			record.status = "ready";
			record.handle = new ManagedSessionHandle(record, (target) => this.#disposeRecord(target));
			return record.handle;
		} catch (cause) {
			let cleanupError: Error | undefined;
			if (session && !record.handle && !ownedByAnotherRecord) {
				try {
					await session.dispose();
				} catch (error) {
					cleanupError = toError(error);
					record.cleanupError = cleanupError;
				}
			}

			if (record.status === "creating") {
				record.status = "disposed";
				if (this.#records.get(record.id) === record) this.#records.delete(record.id);
			}

			const error = record.createController.signal.aborted
				? toError(record.createController.signal.reason)
				: toError(cause);
			if (cleanupError) {
				throw new AggregateError([error, cleanupError], "Session creation failed and cleanup reported errors.", {
					cause: error,
				});
			}
			throw error;
		} finally {
			record.removeAbortListeners();
		}
	}

	#disposeRecord(record: SessionRecord): Promise<void> {
		if (record.disposePromise) return record.disposePromise;
		if (record.status === "disposed") return Promise.resolve();

		const wasCreating = record.status === "creating";
		record.status = "disposing";
		if (!record.createController.signal.aborted) {
			record.createController.abort(createAbortError(`Session ${record.id} disposed during creation.`));
		}

		let sessionDispose: Promise<void> | undefined;
		let synchronousDisposeError: Error | undefined;
		if (record.session) {
			try {
				sessionDispose = record.session.dispose();
			} catch (error) {
				synchronousDisposeError = toError(error);
			}
		}

		record.disposePromise = (async () => {
			const errors: Error[] = [];
			if (synchronousDisposeError) errors.push(synchronousDisposeError);
			if (wasCreating) {
				try {
					await record.createPromise;
				} catch {
					// Cancellation/factory failure is reported to createSession(); dispose only reports cleanup failures.
				}
				if (record.cleanupError) errors.push(record.cleanupError);
			} else if (sessionDispose) {
				try {
					await sessionDispose;
				} catch (error) {
					errors.push(toError(error));
				}
			}

			record.status = "disposed";
			if (record.session && this.#ownedSessions.get(record.session) === record.id) {
				this.#ownedSessions.delete(record.session);
			}
			if (this.#records.get(record.id) === record) this.#records.delete(record.id);

			if (errors.length === 1) throw errors[0];
			if (errors.length > 1) throw new AggregateError(errors, `Session ${record.id} failed to dispose.`);
		})();
		return record.disposePromise;
	}
}
