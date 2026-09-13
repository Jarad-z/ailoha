import type {
	AgentContext,
	AgentMessage,
	AgentTool,
	BeginRunContextRequest,
	CompactRequest,
	CompactResult,
	ContextSnapshot,
	DefaultContextManagerOptions,
	ManualCompactRequest,
	SystemPromptMetadata,
} from "./types.js";
import { AgentTurnLimitError, ContextCompactionError } from "./errors.js";
import { ContextCompactionEngine } from "./context-compaction.js";
import { awaitWithAbortCheck, freezeMessages } from "./utils.js";
import {
	loadWorkspaceInstructions,
	normalizeWorkspaceInstructionFile,
	renderWorkspaceInstructions,
} from "./workspace.js";

interface ContextState {
	messages: readonly AgentMessage[];
	messageIds: readonly string[];
}

class RunContext implements AgentContext {
	readonly systemPrompt: string;
	readonly systemPromptMetadata: SystemPromptMetadata;
	readonly tools: readonly AgentTool[];
	readonly #state: ContextState;

	constructor(
		systemPrompt: string,
		systemPromptMetadata: SystemPromptMetadata,
		tools: readonly AgentTool[],
		state: ContextState,
	) {
		this.systemPrompt = systemPrompt;
		this.systemPromptMetadata = systemPromptMetadata;
		this.tools = tools;
		this.#state = state;
	}

	get messages(): readonly AgentMessage[] {
		return this.#state.messages;
	}
}

export class DefaultContextManager {
	readonly maxTurns: number;
	readonly #systemPrompts: readonly string[];
	readonly #workspace: DefaultContextManagerOptions["workspace"];
	readonly #loadWorkspaceInstructions: NonNullable<DefaultContextManagerOptions["loadWorkspaceInstructions"]>;
	readonly #compactor: DefaultContextManagerOptions["compactor"];
	readonly #compaction?: ContextCompactionEngine;
	readonly #prepareRun: DefaultContextManagerOptions["prepareRun"];
	readonly #joinSystemPrompts: NonNullable<DefaultContextManagerOptions["joinSystemPrompts"]>;
	readonly #state: ContextState;
	#activeContext?: RunContext;
	#turnCount = 0;
	#revision = 0;
	#nextMessageId = 1;
	#nextCheckpointId = 1;

	constructor(options: DefaultContextManagerOptions = {}) {
		if (options.compactor && options.compaction) {
			throw new Error("Use either compactor or compaction, not both.");
		}
		const maxTurns = options.maxTurns ?? Number.POSITIVE_INFINITY;
		if (maxTurns !== Number.POSITIVE_INFINITY && (!Number.isInteger(maxTurns) || maxTurns < 0)) {
			throw new RangeError("maxTurns must be a non-negative integer or Infinity.");
		}
		this.maxTurns = maxTurns;
		this.#systemPrompts = Object.freeze([...(options.systemPrompts ?? [])]);
		this.#workspace = options.workspace;
		this.#loadWorkspaceInstructions = options.loadWorkspaceInstructions ?? loadWorkspaceInstructions;
		this.#compactor = options.compactor;
		this.#compaction = options.compaction ? new ContextCompactionEngine(options.compaction) : undefined;
		this.#prepareRun = options.prepareRun;
		this.#joinSystemPrompts = options.joinSystemPrompts ?? ((prompts) => prompts.join("\n\n"));
		const messages = freezeMessages(options.messages ?? []);
		this.#state = { messages, messageIds: Object.freeze(messages.map(() => this.#createMessageId())) };
	}

	get turnCount(): number {
		return this.#turnCount;
	}

	get canCompact(): boolean {
		return this.#compactor !== undefined || this.#compaction !== undefined;
	}

	consumeTurn(): void {
		if (this.#turnCount >= this.maxTurns) {
			throw new AgentTurnLimitError(this.maxTurns, this.#turnCount);
		}
		this.#turnCount++;
	}

	async beginRun(request: BeginRunContextRequest): Promise<AgentContext> {
		const snapshot = this.snapshot();
		if (this.#prepareRun) {
			await awaitWithAbortCheck(Promise.resolve(this.#prepareRun(request, snapshot)), request.signal);
		}
		const preparedSystemPrompt = await this.#prepareEffectiveSystemPrompt(request.signal);
		const tools = request.tools;
		const promptMessageIds = request.promptMessages.map(() => this.#createMessageId());
		const messages = freezeMessages([...this.#state.messages, ...request.promptMessages]);
		const messageIds = Object.freeze([...this.#state.messageIds, ...promptMessageIds]);
		request.signal.throwIfAborted();

		this.#state.messages = messages;
		this.#state.messageIds = messageIds;
		this.#revision++;
		const context = new RunContext(
			preparedSystemPrompt.systemPrompt,
			preparedSystemPrompt.metadata,
			tools,
			this.#state,
		);
		this.#activeContext = context;
		return context;
	}

	append(context: AgentContext, messages: AgentMessage | readonly AgentMessage[]): void {
		this.#assertActive(context);
		const batch = Array.isArray(messages) ? messages : [messages];
		if (batch.length === 0) return;
		this.#state.messages = freezeMessages([...this.#state.messages, ...batch]);
		this.#state.messageIds = Object.freeze([...this.#state.messageIds, ...batch.map(() => this.#createMessageId())]);
		this.#revision++;
	}

	async compact(request: CompactRequest): Promise<CompactResult> {
		this.#assertActive(request.context);
		if (this.#compaction) {
			return await this.#runBuiltInCompaction({
				reason: request.reason,
				systemPrompt: request.context.systemPrompt,
				tools: request.context.tools,
				error: request.error,
				signal: request.signal,
			});
		}
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
		this.#state.messageIds = Object.freeze(messages.map(() => this.#createMessageId()));
		this.#revision++;
		return { changed: true, beforeTokens: output.beforeTokens, afterTokens: output.afterTokens };
	}

	async compactCurrent(request: ManualCompactRequest): Promise<CompactResult> {
		request.signal.throwIfAborted();
		if (!this.#compaction && !this.#compactor) return { changed: false };
		// Preserve the legacy synchronous path when there is no workspace. AgentService
		// starts manual compaction in the background and existing callers rely on the
		// configured compactor being entered before compactCurrent first yields.
		const preparedSystemPrompt = this.#workspace
			? await this.#prepareEffectiveSystemPrompt(request.signal)
			: {
					systemPrompt: this.#joinSystemPrompts(this.#systemPrompts),
					metadata: Object.freeze({
						fragmentCount: this.#systemPrompts.length,
						workspaceInstructionsLoaded: false,
					}),
				};
		if (this.#compaction) {
			return await this.#runBuiltInCompaction({
				reason: "manual",
				systemPrompt: preparedSystemPrompt.systemPrompt,
				tools: this.#activeContext?.tools ?? [],
				signal: request.signal,
			});
		}
		if (!this.#compactor) return { changed: false };
		const originalMessages = this.#state.messages;
		const snapshot = freezeMessages(originalMessages);
		const output = await awaitWithAbortCheck(
			Promise.resolve(
				this.#compactor({
					reason: "manual",
					systemPrompt: preparedSystemPrompt.systemPrompt,
					messages: snapshot,
					signal: request.signal,
				}),
			),
			request.signal,
		);
		if (!output) return { changed: false };
		const messages = freezeMessages(output.messages);
		request.signal.throwIfAborted();
		if (this.#state.messages !== originalMessages) {
			throw new Error("Context changed while manual compaction was running.");
		}
		this.#state.messages = messages;
		this.#state.messageIds = Object.freeze(messages.map(() => this.#createMessageId()));
		this.#revision++;
		return { changed: true, beforeTokens: output.beforeTokens, afterTokens: output.afterTokens };
	}

	snapshot(): ContextSnapshot {
		return {
			...(this.#workspace ? { workspace: this.#workspace } : {}),
			systemPrompts: this.#systemPrompts,
			messages: this.#state.messages,
		};
	}

	async #prepareEffectiveSystemPrompt(signal: AbortSignal): Promise<{
		readonly systemPrompt: string;
		readonly metadata: SystemPromptMetadata;
	}> {
		const loaded = this.#workspace
			? normalizeWorkspaceInstructionFile(
					await awaitWithAbortCheck(
						this.#loadWorkspaceInstructions({ workspace: this.#workspace, signal }),
						signal,
					),
				)
			: undefined;
		const workspaceFragment = loaded ? renderWorkspaceInstructions(loaded.content) : undefined;
		const fragments = workspaceFragment
			? Object.freeze([...this.#systemPrompts, workspaceFragment])
			: this.#systemPrompts;
		const systemPrompt = this.#joinSystemPrompts(fragments);
		signal.throwIfAborted();
		return {
			systemPrompt,
			metadata: Object.freeze({
				fragmentCount: fragments.length,
				workspaceInstructionsLoaded: loaded !== undefined,
				...(loaded
					? {
						workspaceInstructionsBytes: loaded.byteLength,
						workspaceInstructionsSha256: loaded.sha256,
					}
					: {}),
			}),
		};
	}

	#assertActive(context: AgentContext): void {
		if (context !== this.#activeContext) throw new Error("Context does not belong to the active run.");
	}

	async #runBuiltInCompaction(input: {
		readonly reason: CompactRequest["reason"];
		readonly systemPrompt: string;
		readonly tools: readonly AgentTool[];
		readonly error?: Error;
		readonly signal: AbortSignal;
	}): Promise<CompactResult> {
		if (!this.#compaction) return { changed: false };
		const revision = this.#revision;
		const messages = freezeMessages(structuredClone(this.#state.messages));
		const messageIds = Object.freeze([...this.#state.messageIds]);
		const result = await awaitWithAbortCheck(
			this.#compaction.compact({
				...input,
				messages,
				messageIds,
				createCheckpointId: () => `checkpoint.${this.#nextCheckpointId++}`,
			}),
			input.signal,
		);
		if (!result.changed) return result;
		if (!result.messages || !result.messageIds || result.messages.length !== result.messageIds.length) {
			throw new Error("Built-in compaction returned an invalid committed projection.");
		}
		input.signal.throwIfAborted();
		if (this.#revision !== revision) {
			throw new ContextCompactionError(
				"CONTEXT_REVISION_CONFLICT",
				"Context changed while compaction was running.",
			);
		}
		this.#state.messages = freezeMessages(result.messages);
		this.#state.messageIds = Object.freeze([...result.messageIds]);
		this.#revision++;
		const { messages: _messages, messageIds: _messageIds, ...publicResult } = result;
		return publicResult;
	}

	#createMessageId(): string {
		return `message.${this.#nextMessageId++}`;
	}
}
