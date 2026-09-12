import type { ImageContent, TextContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { AgentStateError, MessageAdmissionError, ModelError, createAbortError, isAbortError, toError } from "./errors.js";
import { MessageQueue } from "./message-queue.js";
import { validateJsonSchema } from "./schema.js";
import type {
	AgentAssistantMessage,
	AgentContext,
	AgentInputMessage,
	AgentOptions,
	AgentState,
	RunResult,
} from "./types.js";
import { assertAgentInputMessage, awaitWithAbortCheck, formatError, freezeMessages, normalizePromptInput } from "./utils.js";

type RunPhase = "react" | "follow_up" | "closing";

interface ActiveRun {
	readonly controller: AbortController;
	readonly signal: AbortSignal;
	phase: RunPhase;
}

export class Agent {
	readonly state: AgentState;
	readonly #modelRunner: AgentOptions["modelRunner"];
	readonly #contextManager: AgentOptions["contextManager"];
	readonly #toolManager: AgentOptions["toolManager"];
	readonly #toolRequests: AgentOptions["toolRequests"];
	readonly #steerQueue = new MessageQueue();
	readonly #followUpQueue = new MessageQueue();
	#activeRun?: ActiveRun;
	#idlePromise: Promise<void> = Promise.resolve();
	#resolveIdle?: () => void;

	constructor(options: AgentOptions) {
		this.state = { model: options.model, status: "idle" };
		this.#modelRunner = options.modelRunner;
		this.#contextManager = options.contextManager;
		this.#toolManager = options.toolManager;
		this.#toolRequests = Object.freeze([...(options.toolRequests ?? [])]);
	}

	prompt(input: string | AgentInputMessage | readonly AgentInputMessage[]): Promise<RunResult> {
		let promptMessages: AgentInputMessage[];
		try {
			promptMessages = normalizePromptInput(input);
		} catch (error) {
			return Promise.reject(error);
		}
		if (this.state.status !== "idle") return Promise.reject(new AgentStateError("Agent is already running."));

		const controller = new AbortController();
		const activeRun: ActiveRun = { controller, signal: controller.signal, phase: "react" };
		this.#activeRun = activeRun;
		this.state.status = "running";
		this.state.lastError = undefined;
		this.#idlePromise = new Promise((resolve) => {
			this.#resolveIdle = resolve;
		});
		return this.#runPromptMessages(promptMessages, activeRun);
	}

	steer(message: AgentInputMessage): void {
		assertAgentInputMessage(message);
		if (this.state.status !== "running" || !this.#activeRun) {
			throw new AgentStateError("Cannot steer an idle agent.");
		}
		if (this.#activeRun.phase !== "react") {
			throw new MessageAdmissionError(`Cannot accept steer messages during ${this.#activeRun.phase}.`);
		}
		this.#steerQueue.enqueue(message);
	}

	followUp(message: AgentInputMessage): void {
		assertAgentInputMessage(message);
		if (this.state.status !== "running" || !this.#activeRun) {
			throw new AgentStateError("Cannot add a follow-up to an idle agent.");
		}
		if (this.#activeRun.phase === "closing") {
			throw new MessageAdmissionError("Cannot accept follow-up messages while the run is closing.");
		}
		this.#followUpQueue.enqueue(message);
	}

	abort(): void {
		if (!this.#activeRun) return;
		this.#activeRun.phase = "closing";
		this.#activeRun.controller.abort(createAbortError());
	}

	waitForIdle(): Promise<void> {
		return this.#idlePromise;
	}

	async #runPromptMessages(promptMessages: AgentInputMessage[], activeRun: ActiveRun): Promise<RunResult> {
		try {
			const tools = await awaitWithAbortCheck(
				this.#toolManager.instantiate(this.#toolRequests ?? [], {
					model: this.state.model,
					signal: activeRun.signal,
				}),
				activeRun.signal,
			);
			const context = await awaitWithAbortCheck(
				this.#contextManager.beginRun({ promptMessages, tools, signal: activeRun.signal }),
				activeRun.signal,
			);
			return await awaitWithAbortCheck(this.#runAgentLoop(context, activeRun), activeRun.signal);
		} catch (cause) {
			activeRun.phase = "closing";
			const error = toError(cause);
			this.state.lastError = error;
			throw error;
		} finally {
			activeRun.phase = "closing";
			this.#steerQueue.clear();
			this.#followUpQueue.clear();
			this.state.activeAssistantMessage = undefined;
			this.state.status = "idle";
			if (this.#activeRun === activeRun) this.#activeRun = undefined;
			this.#resolveIdle?.();
			this.#resolveIdle = undefined;
		}
	}

	async #runAgentLoop(context: AgentContext, activeRun: ActiveRun): Promise<RunResult> {
		while (true) {
			activeRun.phase = "react";
			await awaitWithAbortCheck(this.#runReactLoop(context, activeRun), activeRun.signal);
			const followUps = this.#followUpQueue.drain();
			if (followUps.length === 0) {
				activeRun.phase = "closing";
				return this.#createRunResult(context);
			}
			this.#contextManager.append(context, followUps);
		}
	}

	async #runReactLoop(context: AgentContext, activeRun: ActiveRun): Promise<void> {
		const { signal } = activeRun;
		while (true) {
			signal.throwIfAborted();
			this.state.activeAssistantMessage = undefined;
			await awaitWithAbortCheck(
				this.#contextManager.compact({ reason: "before_llm", context, signal }),
				signal,
			);

			const assistant = await awaitWithAbortCheck(this.#runLlmWithCompactRecovery(context, signal), signal);
			this.state.activeAssistantMessage = assistant;
			this.#contextManager.append(context, assistant);
			const toolCalls = assistant.content.filter((block): block is ToolCall => block.type === "toolCall");

			for (let index = 0; index < toolCalls.length; index++) {
				try {
					signal.throwIfAborted();
					const result = await awaitWithAbortCheck(this.#executeToolCall(context, toolCalls[index], signal), signal);
					this.#contextManager.append(context, result);
				} catch (cause) {
					const error = toError(cause);
					if (!signal.aborted && !isAbortError(error)) throw error;
					this.#contextManager.append(
						context,
						this.#createCancellationToolResults(toolCalls.slice(index), signal.aborted ? signal.reason : error),
					);
					if (signal.aborted) signal.throwIfAborted();
					throw error;
				}
			}

			const steering = this.#steerQueue.drain();
			this.#contextManager.append(context, steering);
			if (toolCalls.length === 0 && steering.length === 0) {
				activeRun.phase = "follow_up";
				return;
			}
		}
	}

	async #runLlmWithCompactRecovery(context: AgentContext, signal: AbortSignal): Promise<AgentAssistantMessage> {
		try {
			return await this.#runLlmAttempt(context, signal);
		} catch (cause) {
			if (signal.aborted) signal.throwIfAborted();
			const error = toError(cause);
			if (isAbortError(error)) throw error;
			const result = await awaitWithAbortCheck(
				this.#contextManager.compact({ reason: "llm_error", context, error, signal }),
				signal,
			);
			if (!result.changed) throw error;
			return await this.#runLlmAttempt(context, signal);
		}
	}

	async #runLlmAttempt(context: AgentContext, signal: AbortSignal): Promise<AgentAssistantMessage> {
		const assistant = await awaitWithAbortCheck(this.#modelRunner.run(context, { signal }), signal);
		if (assistant.stopReason === "aborted") {
			if (signal.aborted) signal.throwIfAborted();
			throw createAbortError(assistant.errorMessage ?? "Model call aborted.");
		}
		if (assistant.stopReason === "error") {
			throw new ModelError(assistant.errorMessage ?? "Model call failed.");
		}
		return assistant;
	}

	async #executeToolCall(context: AgentContext, call: ToolCall, signal: AbortSignal): Promise<ToolResultMessage<unknown>> {
		const tool = context.tools.find((candidate) => candidate.name === call.name);
		if (!tool) return this.#toolError(call, `Tool not found: ${call.name}`);
		const validation = validateJsonSchema(tool.parameters, call.arguments);
		if (!validation.valid) return this.#toolError(call, validation.error ?? "Invalid tool arguments.");
		try {
			signal.throwIfAborted();
			const result = await awaitWithAbortCheck(
				tool.execute(call, { model: this.state.model, context, signal }),
				signal,
			);
			return {
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: this.#normalizeToolContent(result.content),
				details: result.details,
				isError: result.isError ?? false,
				timestamp: Date.now(),
			};
		} catch (cause) {
			if (signal.aborted) signal.throwIfAborted();
			if (isAbortError(cause)) throw cause;
			return this.#toolError(call, formatError(cause));
		}
	}

	#normalizeToolContent(content: string | readonly (TextContent | ImageContent)[]): (TextContent | ImageContent)[] {
		return typeof content === "string" ? [{ type: "text", text: content }] : [...content];
	}

	#toolError(call: ToolCall, message: string): ToolResultMessage<unknown> {
		return {
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text: message }],
			isError: true,
			timestamp: Date.now(),
		};
	}

	#createCancellationToolResults(calls: readonly ToolCall[], reason: unknown): ToolResultMessage<unknown>[] {
		return calls.map((call, index) => ({
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [
				{
					type: "text",
					text:
						index === 0
							? `Tool call cancelled: ${formatError(reason)}`
							: "Tool call skipped because the run was cancelled.",
				},
			],
			isError: true,
			timestamp: Date.now(),
		}));
	}

	#createRunResult(context: AgentContext): RunResult {
		const messages = freezeMessages(context.messages);
		const finalAssistantMessage = [...messages]
			.reverse()
			.find((message): message is AgentAssistantMessage => message.role === "assistant");
		return { messages, finalAssistantMessage };
	}
}
