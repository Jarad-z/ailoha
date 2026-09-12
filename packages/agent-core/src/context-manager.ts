import type {
	AgentContext,
	AgentMessage,
	AgentTool,
	BeginRunContextRequest,
	CompactRequest,
	CompactResult,
	ContextSnapshot,
	DefaultContextManagerOptions,
} from "./types.js";
import { awaitWithAbortCheck, freezeMessages } from "./utils.js";

interface ContextState {
	messages: readonly AgentMessage[];
}

class RunContext implements AgentContext {
	readonly systemPrompt: string;
	readonly tools: readonly AgentTool[];
	readonly #state: ContextState;

	constructor(systemPrompt: string, tools: readonly AgentTool[], state: ContextState) {
		this.systemPrompt = systemPrompt;
		this.tools = tools;
		this.#state = state;
	}

	get messages(): readonly AgentMessage[] {
		return this.#state.messages;
	}
}

export class DefaultContextManager {
	readonly #systemPrompts: readonly string[];
	readonly #compactor: DefaultContextManagerOptions["compactor"];
	readonly #prepareRun: DefaultContextManagerOptions["prepareRun"];
	readonly #joinSystemPrompts: NonNullable<DefaultContextManagerOptions["joinSystemPrompts"]>;
	readonly #state: ContextState;
	#activeContext?: RunContext;

	constructor(options: DefaultContextManagerOptions = {}) {
		this.#systemPrompts = Object.freeze([...(options.systemPrompts ?? [])]);
		this.#compactor = options.compactor;
		this.#prepareRun = options.prepareRun;
		this.#joinSystemPrompts = options.joinSystemPrompts ?? ((prompts) => prompts.join("\n\n"));
		this.#state = { messages: freezeMessages(options.messages ?? []) };
	}

	async beginRun(request: BeginRunContextRequest): Promise<AgentContext> {
		const snapshot = this.snapshot();
		if (this.#prepareRun) {
			await awaitWithAbortCheck(Promise.resolve(this.#prepareRun(request, snapshot)), request.signal);
		}
		const systemPrompt = this.#joinSystemPrompts(this.#systemPrompts);
		const tools = Object.freeze([...request.tools]);
		const messages = freezeMessages([...this.#state.messages, ...request.promptMessages]);
		request.signal.throwIfAborted();

		this.#state.messages = messages;
		const context = new RunContext(systemPrompt, tools, this.#state);
		this.#activeContext = context;
		return context;
	}

	append(context: AgentContext, messages: AgentMessage | readonly AgentMessage[]): void {
		this.#assertActive(context);
		const batch = Array.isArray(messages) ? messages : [messages];
		if (batch.length === 0) return;
		this.#state.messages = freezeMessages([...this.#state.messages, ...batch]);
	}

	async compact(request: CompactRequest): Promise<CompactResult> {
		this.#assertActive(request.context);
		if (!this.#compactor) return { changed: false };
		const output = await awaitWithAbortCheck(
			Promise.resolve(
				this.#compactor({
					reason: request.reason,
					systemPrompt: request.context.systemPrompt,
					messages: freezeMessages(request.context.messages),
					error: request.error,
					signal: request.signal,
				}),
			),
			request.signal,
		);
		if (!output) return { changed: false };
		const messages = freezeMessages(output.messages);
		request.signal.throwIfAborted();
		this.#state.messages = messages;
		return { changed: true, beforeTokens: output.beforeTokens, afterTokens: output.afterTokens };
	}

	snapshot(): ContextSnapshot {
		return { systemPrompts: this.#systemPrompts, messages: this.#state.messages };
	}

	#assertActive(context: AgentContext): void {
		if (context !== this.#activeContext) throw new Error("Context does not belong to the active run.");
	}
}
