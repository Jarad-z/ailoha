import type { AgentTool, ToolFactory, ToolInitContext, ToolRequest } from "./types.js";
import { AgentStateError, toError } from "./errors.js";
import { awaitWithAbortCheck } from "./utils.js";

export type ToolManagerStatus = "configuring" | "initializing" | "ready" | "disposed";

const toolInstanceOwners = new WeakMap<object, string>();

export class ToolManager {
	readonly #factories = new Map<string, ToolFactory>();
	#status: ToolManagerStatus = "configuring";
	#tools: readonly AgentTool[] = Object.freeze([]);
	#disposePromise?: Promise<void>;

	get status(): ToolManagerStatus {
		return this.#status;
	}

	register(name: string, factory: ToolFactory): void {
		if (this.#status !== "configuring") {
			throw new AgentStateError(`Cannot register tools while ToolManager is ${this.#status}.`);
		}
		if (!name) throw new Error("Tool factory name cannot be empty.");
		if (this.#factories.has(name)) throw new Error(`Tool factory already registered: ${name}`);
		this.#factories.set(name, factory);
	}

	async initialize(requests: readonly ToolRequest[], context: ToolInitContext): Promise<void> {
		if (this.#status !== "configuring") {
			throw new AgentStateError(`Cannot initialize ToolManager while it is ${this.#status}.`);
		}
		this.#status = "initializing";
		const tools: AgentTool[] = [];
		try {
			const requestedNames = new Set<string>();
			for (const request of requests) {
				context.signal.throwIfAborted();
				if (requestedNames.has(request.name)) throw new Error(`Duplicate tool request: ${request.name}`);
				requestedNames.add(request.name);
				const factory = this.#factories.get(request.name);
				if (!factory) throw new Error(`Unknown tool: ${request.name}`);
				const tool = await awaitWithAbortCheck(
					Promise.resolve(factory(request, context)).then((createdTool) => {
						const owner = toolInstanceOwners.get(createdTool);
						if (owner !== undefined) {
							throw new Error(`Tool instance ${createdTool.name} is already owned by Session ${owner}.`);
						}
						toolInstanceOwners.set(createdTool, context.sessionId);
						tools.push(createdTool);
						return createdTool;
					}),
					context.signal,
				);
				if (tool.name !== request.name) {
					throw new Error(`Tool factory for ${request.name} returned tool named ${tool.name}.`);
				}
			}
			this.#tools = Object.freeze([...tools]);
			this.#status = "ready";
		} catch (cause) {
			this.#status = "disposed";
			this.#factories.clear();
			this.#tools = Object.freeze([]);
			const cleanupErrors = await this.#disposeTools(tools);
			if (cleanupErrors.length > 0) {
				const error = toError(cause);
				throw new AggregateError(
					[error, ...cleanupErrors],
					"Tool initialization failed and cleanup reported errors.",
					{ cause: error },
				);
			}
			throw cause;
		}
	}

	get tools(): readonly AgentTool[] {
		if (this.#status !== "ready") {
			throw new AgentStateError(`Cannot read tools while ToolManager is ${this.#status}.`);
		}
		return this.#tools;
	}

	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		if (this.#status === "disposed") return Promise.resolve();
		if (this.#status === "initializing") {
			return Promise.reject(new AgentStateError("Cannot dispose ToolManager while it is initializing."));
		}

		const tools = this.#status === "ready" ? this.#tools : [];
		this.#status = "disposed";
		this.#tools = Object.freeze([]);
		this.#factories.clear();
		this.#disposePromise = (async () => {
			const errors = await this.#disposeTools(tools);
			if (errors.length > 0) throw new AggregateError(errors, "One or more tools failed to dispose.");
		})();
		return this.#disposePromise;
	}

	async #disposeTools(tools: readonly AgentTool[]): Promise<Error[]> {
		const errors: Error[] = [];
		for (let index = tools.length - 1; index >= 0; index--) {
			try {
				await tools[index].dispose?.();
			} catch (error) {
				errors.push(toError(error));
			}
		}
		return errors;
	}
}
