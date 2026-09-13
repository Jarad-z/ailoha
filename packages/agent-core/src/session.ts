import { Agent } from "./agent.js";
import { DefaultContextManager } from "./context-manager.js";
import { createAbortError, toError } from "./errors.js";
import { createSessionId, validateSessionId } from "./session-id.js";
import { ToolManager } from "./tool-manager.js";
import type { TraceOptions, TraceSink } from "./trace-types.js";
import type {
	AgentModel,
	ContextManager,
	DefaultContextManagerOptions,
	ModelRunner,
	SessionId,
	ToolRequest,
} from "./types.js";

export interface SessionFactoryContext {
	readonly sessionId: SessionId;
	readonly model: AgentModel;
	readonly signal: AbortSignal;
}

export interface SessionCreateOptions {
	readonly id?: SessionId;
	readonly signal?: AbortSignal;
}

export interface SessionOptions {
	readonly model: AgentModel;
	readonly createModelRunner: (context: SessionFactoryContext) => ModelRunner;
	readonly contextManagerOptions?: DefaultContextManagerOptions;
	readonly createContextManager?: (context: SessionFactoryContext) => ContextManager;
	readonly createToolManager?: (context: SessionFactoryContext) => ToolManager;
	readonly configureTools?: (manager: ToolManager, context: SessionFactoryContext) => void;
	readonly toolRequests?: readonly ToolRequest[];
	readonly trace?: false | TraceOptions;
}

const contextManagerOwners = new WeakMap<object, SessionId>();
const toolManagerOwners = new WeakMap<ToolManager, SessionId>();

export class Session {
	readonly sessionId: SessionId;
	readonly agent: Agent;
	readonly #lifetimeController: AbortController;
	readonly #ownedTraceSink?: TraceSink;
	#disposePromise?: Promise<void>;

	private constructor(
		sessionId: SessionId,
		agent: Agent,
		lifetimeController: AbortController,
		ownedTraceSink?: TraceSink,
	) {
		this.sessionId = sessionId;
		this.agent = agent;
		this.#lifetimeController = lifetimeController;
		this.#ownedTraceSink = ownedTraceSink;
	}

	static async create(options: SessionOptions, createOptions: SessionCreateOptions = {}): Promise<Session> {
		if (options.createContextManager && options.contextManagerOptions) {
			throw new Error("Use either createContextManager or contextManagerOptions, not both.");
		}

		const sessionId = validateSessionId(createOptions.id ?? createSessionId());
		const creationSignal = createOptions.signal;
		creationSignal?.throwIfAborted();

		const lifetimeController = new AbortController();
		let removeCreationAbortListener: (() => void) | undefined;
		if (creationSignal) {
			const forwardCreationAbort = () => {
				if (!lifetimeController.signal.aborted) {
					lifetimeController.abort(creationSignal.reason ?? createAbortError("Session creation aborted."));
				}
			};
			creationSignal.addEventListener("abort", forwardCreationAbort, { once: true });
			removeCreationAbortListener = () => creationSignal.removeEventListener("abort", forwardCreationAbort);
			if (creationSignal.aborted) forwardCreationAbort();
		}
		const context: SessionFactoryContext = Object.freeze({
			sessionId,
			model: options.model,
			signal: lifetimeController.signal,
		});
		let toolManager: ToolManager | undefined;
		let ownsContextManager = false;
		let ownsToolManager = false;
		let contextManager: ContextManager | undefined;
		try {
			lifetimeController.signal.throwIfAborted();
			const modelRunner = options.createModelRunner(context);
			lifetimeController.signal.throwIfAborted();
			contextManager = options.createContextManager?.(context) ?? new DefaultContextManager(options.contextManagerOptions);
			lifetimeController.signal.throwIfAborted();
			const contextOwner = contextManagerOwners.get(contextManager);
			if (contextOwner !== undefined) {
				throw new Error(`ContextManager is already owned by Session ${contextOwner}.`);
			}
			contextManagerOwners.set(contextManager, sessionId);
			ownsContextManager = true;

			const createdToolManager = options.createToolManager?.(context) ?? new ToolManager();
			lifetimeController.signal.throwIfAborted();
			const toolManagerOwner = toolManagerOwners.get(createdToolManager);
			if (toolManagerOwner !== undefined) {
				throw new Error(`ToolManager is already owned by Session ${toolManagerOwner}.`);
			}
			toolManagerOwners.set(createdToolManager, sessionId);
			toolManager = createdToolManager;
			ownsToolManager = true;
			options.configureTools?.(toolManager, context);
			lifetimeController.signal.throwIfAborted();
			await toolManager.initialize(options.toolRequests ?? [], {
				sessionId,
				model: options.model,
				signal: lifetimeController.signal,
			});

			lifetimeController.signal.throwIfAborted();
			const agent = new Agent({
				sessionId,
				model: options.model,
				modelRunner,
				contextManager,
				toolManager,
				trace: options.trace,
			});
			removeCreationAbortListener?.();
			removeCreationAbortListener = undefined;
			const ownedTraceSink =
				options.trace && options.trace.enabled !== false && options.trace.sinkOwnership !== "external"
					? options.trace.sink
					: undefined;
			return new Session(sessionId, agent, lifetimeController, ownedTraceSink);
		} catch (cause) {
			const cleanupErrors: Error[] = [];
			try {
				if (ownsToolManager) await toolManager?.dispose();
			} catch (error) {
				cleanupErrors.push(toError(error));
			}
			if (options.trace && options.trace.enabled !== false && options.trace.sinkOwnership !== "external") {
				try {
					await options.trace.sink.flush?.();
				} catch (error) {
					cleanupErrors.push(toError(error));
				}
				try {
					await options.trace.sink.dispose?.();
				} catch (error) {
					cleanupErrors.push(toError(error));
				}
			}
			if (ownsContextManager && contextManager) contextManagerOwners.delete(contextManager);
			if (!lifetimeController.signal.aborted) lifetimeController.abort(cause);
			if (cleanupErrors.length > 0) {
				const error = toError(cause);
				throw new AggregateError([error, ...cleanupErrors], "Session creation failed and cleanup reported errors.", {
					cause: error,
				});
			}
			throw cause;
		} finally {
			removeCreationAbortListener?.();
		}
	}

	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		const agentDispose = this.agent.dispose();
		this.#disposePromise = (async () => {
			const errors: Error[] = [];
			try {
				try {
					await agentDispose;
				} catch (error) {
					errors.push(toError(error));
				}
				if (this.#ownedTraceSink) {
					try {
						await this.#ownedTraceSink.flush?.();
					} catch (error) {
						errors.push(toError(error));
					}
					try {
						await this.#ownedTraceSink.dispose?.();
					} catch (error) {
						errors.push(toError(error));
					}
				}
			} finally {
				this.#lifetimeController.abort(new Error("Session disposed."));
			}
			if (errors.length === 1) throw errors[0];
			if (errors.length > 1) throw new AggregateError(errors, "Session disposal reported multiple errors.");
		})();
		return this.#disposePromise;
	}
}
