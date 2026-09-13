import type { ImageContent, TextContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	AgentStateError,
	AgentTurnLimitError,
	ContextWindowExceededError,
	MessageAdmissionError,
	ModelError,
	createAbortError,
	isAbortError,
	isContextWindowExceededError,
	toError,
} from "./errors.js";
import { MessageQueue } from "./message-queue.js";
import { validateJsonSchema } from "./schema.js";
import { validateSessionId } from "./session-id.js";
import { TraceRecorder } from "./trace-recorder.js";
import type { RunTraceRecorder, TracedToolExecution } from "./trace-recorder.js";
import type { AgentMessageAdmissionOptions, AgentRunOptions, RunOutcome } from "./trace-types.js";
import type {
	AgentAssistantMessage,
	AgentCompactOptions,
	AgentContext,
	AgentInputMessage,
	AgentOptions,
	AgentState,
	RunResult,
	CompactResult,
} from "./types.js";
import { assertAgentInputMessage, awaitWithAbortCheck, formatError, freezeMessages, normalizePromptInput } from "./utils.js";

type RunPhase = "react" | "follow_up" | "closing";

interface ActiveRun {
	readonly controller: AbortController;
	readonly signal: AbortSignal;
	readonly trace: RunTraceRecorder;
	phase: RunPhase;
}

interface ActiveCompact {
	readonly controller: AbortController;
}

export class Agent {
	readonly sessionId: AgentOptions["sessionId"];
	readonly state: AgentState;
	readonly #modelRunner: AgentOptions["modelRunner"];
	readonly #contextManager: AgentOptions["contextManager"];
	readonly #toolManager: AgentOptions["toolManager"];
	readonly #traceRecorder: TraceRecorder;
	readonly #steerQueue = new MessageQueue();
	readonly #followUpQueue = new MessageQueue();
	#activeRun?: ActiveRun;
	#activeCompact?: ActiveCompact;
	#idlePromise: Promise<void> = Promise.resolve();
	#resolveIdle?: () => void;
	#acceptingPrompts = true;
	#disposePromise?: Promise<void>;

	constructor(options: AgentOptions) {
		if (options.toolManager.status !== "ready") {
			throw new AgentStateError("Agent requires an initialized ToolManager.");
		}
		this.sessionId = validateSessionId(options.sessionId);
		this.state = { model: options.model, status: "idle" };
		this.#modelRunner = options.modelRunner;
		this.#contextManager = options.contextManager;
		this.#toolManager = options.toolManager;
		this.#traceRecorder = new TraceRecorder(this.sessionId, options.model, options.trace);
	}

	prompt(
		input: string | AgentInputMessage | readonly AgentInputMessage[],
		options: AgentRunOptions = {},
	): Promise<RunResult> {
		if (!this.#acceptingPrompts) return Promise.reject(new AgentStateError("Agent is disposed."));
		if (this.#turnLimitReached()) return Promise.reject(this.#turnLimitError());
		let promptMessages: AgentInputMessage[];
		try {
			promptMessages = normalizePromptInput(input);
		} catch (error) {
			return Promise.reject(error);
		}
		if (this.state.status !== "idle") return Promise.reject(new AgentStateError("Agent is already running."));

		let trace: RunTraceRecorder;
		try {
			trace = this.#traceRecorder.createRun(promptMessages.length, options);
		} catch (error) {
			return Promise.reject(error);
		}

		const controller = new AbortController();
		const activeRun: ActiveRun = { controller, signal: controller.signal, trace, phase: "react" };
		this.#activeRun = activeRun;
		this.state.status = "running";
		this.state.lastError = undefined;
		this.#idlePromise = new Promise((resolve) => {
			this.#resolveIdle = resolve;
		});
		trace.start();
		return this.#runPromptMessages(promptMessages, activeRun);
	}

	steer(message: AgentInputMessage, options: AgentMessageAdmissionOptions = {}): void {
		assertAgentInputMessage(message);
		if (this.#turnLimitReached()) throw this.#turnLimitError();
		if (this.state.status !== "running" || !this.#activeRun) {
			throw new AgentStateError("Cannot steer an idle agent.");
		}
		if (this.#activeRun.phase !== "react") {
			throw new MessageAdmissionError(`Cannot accept steer messages during ${this.#activeRun.phase}.`);
		}
		this.#steerQueue.enqueue(message);
		this.#activeRun.trace.messageAdmitted("steer", message, options.operationId);
	}

	followUp(message: AgentInputMessage, options: AgentMessageAdmissionOptions = {}): void {
		assertAgentInputMessage(message);
		if (this.#turnLimitReached()) throw this.#turnLimitError();
		if (this.state.status !== "running" || !this.#activeRun) {
			throw new AgentStateError("Cannot add a follow-up to an idle agent.");
		}
		if (this.#activeRun.phase === "closing") {
			throw new MessageAdmissionError("Cannot accept follow-up messages while the run is closing.");
		}
		this.#followUpQueue.enqueue(message);
		this.#activeRun.trace.messageAdmitted("follow_up", message, options.operationId);
	}

	compact(options: AgentCompactOptions = {}): Promise<CompactResult> {
		if (!this.#acceptingPrompts) return Promise.reject(new AgentStateError("Agent is disposed."));
		if (this.state.status !== "idle") {
			return Promise.reject(new AgentStateError("Agent must be idle before manual compaction."));
		}

		const controller = new AbortController();
		const forwardAbort = () => controller.abort(options.signal?.reason ?? createAbortError());
		if (options.signal?.aborted) forwardAbort();
		else options.signal?.addEventListener("abort", forwardAbort, { once: true });
		const removeAbortListener = () => options.signal?.removeEventListener("abort", forwardAbort);

		this.state.status = "compacting";
		this.state.lastError = undefined;
		this.#idlePromise = new Promise((resolve) => {
			this.#resolveIdle = resolve;
		});

		const activeCompact: ActiveCompact = { controller };
		this.#activeCompact = activeCompact;
		return (async () => {
			try {
				controller.signal.throwIfAborted();
				return await awaitWithAbortCheck(
					this.#contextManager.compactCurrent({ signal: controller.signal }),
					controller.signal,
				);
			} catch (cause) {
				const error = toError(cause);
				this.state.lastError = error;
				throw error;
			} finally {
				removeAbortListener();
				this.state.status = "idle";
				if (this.#activeCompact === activeCompact) this.#activeCompact = undefined;
				this.#resolveIdle?.();
				this.#resolveIdle = undefined;
			}
		})();
	}

	abort(): void {
		if (!this.#activeRun) return;
		this.#activeRun.phase = "closing";
		this.#activeRun.controller.abort(createAbortError());
	}

	waitForIdle(): Promise<void> {
		return this.#idlePromise;
	}

	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#acceptingPrompts = false;
		this.abort();
		this.#activeCompact?.controller.abort(createAbortError("Agent disposed during manual compaction."));
		this.#disposePromise = (async () => {
			await this.waitForIdle();
			await this.#toolManager.dispose();
		})();
		return this.#disposePromise;
	}

	async #runPromptMessages(promptMessages: AgentInputMessage[], activeRun: ActiveRun): Promise<RunResult> {
		let traceOutcome: RunOutcome = "success";
		let traceError: Error | undefined;
		try {
			const before = this.#contextManager.snapshot();
			const context = await awaitWithAbortCheck(
				this.#contextManager.beginRun({
					promptMessages,
					tools: this.#toolManager.tools,
					signal: activeRun.signal,
				}),
				activeRun.signal,
			);
			activeRun.trace.contextPrepared(context, before.messages.length, promptMessages.length, before.systemPrompts.length);
			return await awaitWithAbortCheck(this.#runAgentLoop(context, activeRun), activeRun.signal);
		} catch (cause) {
			activeRun.phase = "closing";
			const error = toError(cause);
			this.state.lastError = error;
			traceOutcome = activeRun.signal.aborted || isAbortError(error) ? "cancelled" : "error";
			traceError = error;
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
			activeRun.trace.finish(traceOutcome, traceError);
		}
	}

	async #runAgentLoop(context: AgentContext, activeRun: ActiveRun): Promise<RunResult> {
		while (true) {
			activeRun.phase = "react";
			await awaitWithAbortCheck(this.#runReactLoop(context, activeRun), activeRun.signal);
			const followUps = this.#followUpQueue.drain();
			if (followUps.length === 0) {
				activeRun.phase = "closing";
				return this.#createRunResult(context, activeRun.trace.runId);
			}
			this.#contextManager.append(context, followUps);
		}
	}

	async #runReactLoop(context: AgentContext, activeRun: ActiveRun): Promise<void> {
		const { signal } = activeRun;
		while (true) {
			signal.throwIfAborted();
			this.state.activeAssistantMessage = undefined;
			if (this.#turnLimitReached()) throw this.#turnLimitError();
			await this.#compactWithTrace("before_llm", context, activeRun);

			const { assistant, assistantTurnId } = await awaitWithAbortCheck(this.#runLlmWithCompactRecovery(context, activeRun), signal);
			this.state.activeAssistantMessage = assistant;
			this.#contextManager.append(context, assistant);
			const toolCalls = assistant.content.filter((block): block is ToolCall => block.type === "toolCall");
			const tracedCalls = activeRun.trace.observeToolCalls(assistantTurnId, toolCalls);

			for (let index = 0; index < toolCalls.length; index++) {
				try {
					signal.throwIfAborted();
					const result = await awaitWithAbortCheck(
						this.#executeToolCall(context, toolCalls[index], signal, tracedCalls[index]),
						signal,
					);
					this.#contextManager.append(context, result);
				} catch (cause) {
					const error = toError(cause);
					if (!signal.aborted && !isAbortError(error)) throw error;
					const reason = signal.aborted ? signal.reason : error;
					tracedCalls[index].finishCancelled(reason);
					for (const pending of tracedCalls.slice(index + 1)) pending.finishSkipped(reason);
					this.#contextManager.append(
						context,
						this.#createCancellationToolResults(toolCalls.slice(index), reason),
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

	async #runLlmWithCompactRecovery(context: AgentContext, activeRun: ActiveRun): Promise<{ readonly assistant: AgentAssistantMessage; readonly assistantTurnId: string }> {
		const { signal } = activeRun;
		try {
			return await this.#runLlmAttempt(context, activeRun);
		} catch (cause) {
			if (signal.aborted) signal.throwIfAborted();
			const error = toError(cause);
			if (error instanceof AgentTurnLimitError) throw error;
			if (isAbortError(error)) throw error;
			if (!isContextWindowExceededError(error)) throw error;
			const result = await this.#compactWithTrace("llm_error", context, activeRun, error);
			if (!result.changed) throw error;
			return await this.#runLlmAttempt(context, activeRun);
		}
	}

	async #runLlmAttempt(context: AgentContext, activeRun: ActiveRun): Promise<{ readonly assistant: AgentAssistantMessage; readonly assistantTurnId: string }> {
		const { signal, trace } = activeRun;
		this.#contextManager.consumeTurn();
		const llm = trace.startLlm(context);
		try {
			const assistant = await awaitWithAbortCheck(this.#modelRunner.run(context, { signal }), signal);
			if (assistant.stopReason === "aborted") {
				if (signal.aborted) signal.throwIfAborted();
				throw createAbortError(assistant.errorMessage ?? "Model call aborted.");
			}
			if (assistant.stopReason === "error") {
				const contextOverflow = assistant.diagnostics?.some(
					(diagnostic) =>
						diagnostic.error?.code === "CONTEXT_WINDOW_EXCEEDED" ||
						diagnostic.details?.code === "CONTEXT_WINDOW_EXCEEDED",
				);
				if (contextOverflow) {
					throw new ContextWindowExceededError(assistant.errorMessage ?? "The model context window was exceeded.");
				}
				throw new ModelError(assistant.errorMessage ?? "Model call failed.");
			}
			const calls = assistant.content.filter((block): block is ToolCall => block.type === "toolCall");
			return { assistant, assistantTurnId: trace.observeAssistant(assistant, calls, llm) };
		} catch (cause) {
			const error = toError(cause);
			trace.finishLlmError(llm, error, signal.aborted || isAbortError(error));
			throw error;
		}
	}

	async #compactWithTrace(
		reason: "before_llm" | "llm_error",
		context: AgentContext,
		activeRun: ActiveRun,
		error?: Error,
	): Promise<CompactResult> {
		if (this.#contextManager.canCompact === false) {
			return await awaitWithAbortCheck(
				this.#contextManager.compact({ reason, context, error, signal: activeRun.signal }),
				activeRun.signal,
			);
		}
		const compact = activeRun.trace.startCompact(reason, context.messages.length);
		try {
			const result = await awaitWithAbortCheck(
				this.#contextManager.compact({ reason, context, error, signal: activeRun.signal }),
				activeRun.signal,
			);
			activeRun.trace.finishCompact(compact, result, context.messages.length);
			return result;
		} catch (cause) {
			const compactError = toError(cause);
			activeRun.trace.finishCompact(
				compact,
				undefined,
				context.messages.length,
				compactError,
				activeRun.signal.aborted || isAbortError(compactError),
			);
			throw compactError;
		}
	}

	#turnLimitReached(): boolean {
		return this.#contextManager.turnCount >= this.#contextManager.maxTurns;
	}

	#turnLimitError(): AgentTurnLimitError {
		return new AgentTurnLimitError(this.#contextManager.maxTurns, this.#contextManager.turnCount);
	}

	async #executeToolCall(
		context: AgentContext,
		call: ToolCall,
		signal: AbortSignal,
		trace: TracedToolExecution,
	): Promise<ToolResultMessage<unknown>> {
		const tool = context.tools.find((candidate) => candidate.name === call.name);
		if (!tool) {
			const message = `Tool not found: ${call.name}`;
			trace.finishError("lookup", new Error(message));
			return this.#toolError(call, message);
		}
		const validation = validateJsonSchema(tool.parameters, call.arguments);
		if (!validation.valid) {
			const message = validation.error ?? "Invalid tool arguments.";
			trace.finishError("validation", new Error(message));
			return this.#toolError(call, message);
		}
		try {
			signal.throwIfAborted();
			trace.start();
			const result = await awaitWithAbortCheck(
				tool.execute(call, { sessionId: this.sessionId, model: this.state.model, context, signal }),
				signal,
			);
			trace.finishResult(result);
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
			const error = toError(cause);
			trace.finishError("execution", error);
			return this.#toolError(call, formatError(error));
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

	#createRunResult(context: AgentContext, runId: string): RunResult {
		const messages = freezeMessages(context.messages);
		const finalAssistantMessage = [...messages]
			.reverse()
			.find((message): message is AgentAssistantMessage => message.role === "assistant");
		return { runId, messages, finalAssistantMessage };
	}
}
