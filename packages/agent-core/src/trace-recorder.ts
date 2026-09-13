import { randomUUID } from "node:crypto";
import type { ToolCall } from "@earendil-works/pi-ai";
import { captureError, captureValue, reportTraceError } from "./trace-capture.js";
import type {
	AgentRunOptions,
	CapturedError,
	RunOutcome,
	TraceClock,
	TraceEvent,
	TraceEventBase,
	TraceIdGenerator,
	TraceIdKind,
	TraceOptions,
	TraceSink,
	ToolCallFinishedEvent,
	ToolFailureStage,
	ToolOutcome,
} from "./trace-types.js";
import type { AgentAssistantMessage, AgentModel, ToolExecutionResult } from "./types.js";

const NOOP_SINK: TraceSink = Object.freeze({ emit() {} });

const SYSTEM_CLOCK: TraceClock = Object.freeze({
	nowUnixMs: () => Date.now(),
	nowMonotonicMs: () => performance.now(),
});

const PREFIX_BY_KIND: Readonly<Record<TraceIdKind, string>> = Object.freeze({
	event: "evt",
	run: "run",
	assistant_turn: "turn",
	llm_call: "llm",
	tool_execution: "tex",
	compact: "cmp",
	subscription: "sub",
	hub: "hub",
});

export class DefaultTraceIdGenerator implements TraceIdGenerator {
	generate(kind: TraceIdKind): string {
		return `${PREFIX_BY_KIND[kind]}_${randomUUID()}`;
	}
}

function freezeAttributes(
	base: Readonly<Record<string, string | number | boolean>> | undefined,
	extra: Readonly<Record<string, string | number | boolean>> | undefined,
): Readonly<Record<string, string | number | boolean>> | undefined {
	if (!base && !extra) return undefined;
	return Object.freeze({ ...base, ...extra });
}

function validateRunId(value: string): string {
	if (value.trim().length === 0) throw new TypeError("runId must not be empty.");
	return value;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
	if (typeof value !== "object" || value === null || seen.has(value)) return value;
	seen.add(value);
	for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
	return Object.freeze(value);
}

export interface LlmCallTrace {
	readonly llmCallId: string;
	readonly round: number;
	readonly startedAt: number;
}

export interface CompactTrace {
	readonly compactId: string;
	readonly reason: "before_llm" | "llm_error" | "manual";
	readonly startedAt: number;
	readonly beforeMessageCount: number;
}

export class TraceRecorder {
	readonly #sessionId: string;
	readonly #model: AgentModel;
	readonly #sink: TraceSink;
	readonly #capture: TraceOptions["capture"];
	readonly #level: NonNullable<TraceOptions["level"]>;
	readonly #sessionAttributes: TraceOptions["sessionAttributes"];
	readonly #onError: TraceOptions["onError"];
	readonly #clock: TraceClock;
	readonly #ids: TraceIdGenerator;

	constructor(sessionId: string, model: AgentModel, options?: false | TraceOptions) {
		this.#sessionId = sessionId;
		this.#model = model;
		this.#sink = options && options.enabled !== false ? options.sink : NOOP_SINK;
		this.#capture = options && options.enabled !== false ? options.capture : undefined;
		this.#level = options && options.enabled !== false ? (options.level ?? "execution") : "execution";
		this.#sessionAttributes = options && options.enabled !== false ? options.sessionAttributes : undefined;
		this.#onError = options && options.enabled !== false ? options.onError : undefined;
		this.#clock = (options && options.clock) || SYSTEM_CLOCK;
		this.#ids = (options && options.idGenerator) || new DefaultTraceIdGenerator();
	}

	createRun(inputMessageCount: number, options: AgentRunOptions = {}): RunTraceRecorder {
		const runId = validateRunId(options.runId ?? this.#ids.generate("run"));
		return new RunTraceRecorder({
			sessionId: this.#sessionId,
			runId,
			model: this.#model,
			inputMessageCount,
			correlationId: options.correlationId,
			attributes: freezeAttributes(this.#sessionAttributes, options.traceAttributes),
			sink: this.#sink,
			capture: this.#capture,
			level: this.#level,
			onError: this.#onError,
			clock: this.#clock,
			ids: this.#ids,
		});
	}
}

interface RunTraceRecorderOptions {
	readonly sessionId: string;
	readonly runId: string;
	readonly model: AgentModel;
	readonly inputMessageCount: number;
	readonly correlationId?: string;
	readonly attributes?: Readonly<Record<string, string | number | boolean>>;
	readonly sink: TraceSink;
	readonly capture: TraceOptions["capture"];
	readonly level: NonNullable<TraceOptions["level"]>;
	readonly onError: TraceOptions["onError"];
	readonly clock: TraceClock;
	readonly ids: TraceIdGenerator;
}

export class RunTraceRecorder {
	readonly runId: string;
	readonly #options: RunTraceRecorderOptions;
	readonly #startedMono: number;
	readonly #inputMessageCount: number;
	#sequence = 0;
	#assistantTurnCount = 0;
	#toolCallCount = 0;
	#round = 0;
	#started = false;
	#finished = false;

	constructor(options: RunTraceRecorderOptions) {
		this.#options = options;
		this.runId = options.runId;
		this.#startedMono = options.clock.nowMonotonicMs();
		this.#inputMessageCount = options.inputMessageCount;
	}

	start(): void {
		if (this.#started) return;
		this.#started = true;
		this.#emit({
			type: "agent.run.started",
			inputMessageCount: this.#inputMessageCount,
			model: Object.freeze({
				...(this.#options.model.provider ? { provider: this.#options.model.provider } : {}),
				id: this.#options.model.id,
			}),
		});
	}

	contextPrepared(context: import("./types.js").AgentContext, historyMessageCount: number, inputMessageCount: number, systemPromptCount: number): void {
		const captured = captureValue("result", "", {
			systemPrompt: context.systemPrompt,
			messages: context.messages,
			tools: context.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
		}, { results: "metadata" }, this.#options.onError);
		this.#emit({
			type: "context.prepared",
			systemPromptCount,
			toolCount: context.tools.length,
			historyMessageCount,
			inputMessageCount,
			totalMessageCount: context.messages.length,
			contextSha256: `sha256:${captured.sha256 ?? "unavailable"}`,
		});
	}

	messageAdmitted(delivery: "steer" | "follow_up", message: unknown, operationId?: string): void {
		this.#emit({
			type: "agent.message.admitted",
			delivery,
			...(operationId ? { operationId } : {}),
			message: captureValue("message", "", message, this.#options.capture, this.#options.onError),
		});
	}

	startCompact(reason: CompactTrace["reason"], messageCount: number): CompactTrace {
		const trace = Object.freeze({
			compactId: this.#options.ids.generate("compact"),
			reason,
			startedAt: this.nowMonotonic(),
			beforeMessageCount: messageCount,
		});
		this.#emit({ type: "context.compact.started", compactId: trace.compactId, reason, messageCount });
		return trace;
	}

	finishCompact(trace: CompactTrace, result?: { readonly changed: boolean; readonly beforeTokens?: number; readonly afterTokens?: number }, afterMessageCount?: number, error?: unknown, cancelled = false): void {
		this.#emit({
			type: "context.compact.finished",
			compactId: trace.compactId,
			outcome: error === undefined ? (result?.changed ? "changed" : "unchanged") : cancelled ? "cancelled" : "error",
			durationMs: this.durationSince(trace.startedAt),
			beforeMessageCount: trace.beforeMessageCount,
			...(afterMessageCount === undefined ? {} : { afterMessageCount }),
			...(result?.beforeTokens === undefined ? {} : { beforeTokens: result.beforeTokens }),
			...(result?.afterTokens === undefined ? {} : { afterTokens: result.afterTokens }),
			...(error === undefined ? {} : { error: this.captureError(error) }),
		});
	}

	startLlm(context: import("./types.js").AgentContext): LlmCallTrace {
		const trace = Object.freeze({
			llmCallId: this.#options.ids.generate("llm_call"),
			round: ++this.#round,
			startedAt: this.nowMonotonic(),
		});
		const request = captureValue("request", "", {
			systemPrompt: context.systemPrompt,
			messages: context.messages.map((message) => message.role === "assistant" ? {
				...message,
				content: message.content.map((block) => block.type === "thinking" ? {
					type: "thinking",
					byteLength: Buffer.byteLength(block.thinking, "utf8"),
				} : block),
			} : message),
			tools: context.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
		}, this.#options.capture, this.#options.onError);
		this.#emit({
			type: "llm.call.started",
			round: trace.round,
			llmCallId: trace.llmCallId,
			model: Object.freeze({ ...(this.#options.model.provider ? { provider: this.#options.model.provider } : {}), id: this.#options.model.id }),
			messageCount: context.messages.length,
			toolCount: context.tools.length,
			...(request.mode === "none" ? {} : { request }),
		});
		return trace;
	}

	observeAssistant(message: AgentAssistantMessage, calls: readonly ToolCall[], llm: LlmCallTrace): string {
		this.#assistantTurnCount++;
		const assistantTurnId = this.#options.ids.generate("assistant_turn");
		const textBlocks = message.content.filter((block) => block.type === "text");
		const thinkingBlocks = message.content.filter((block) => block.type === "thinking");
		const response = captureValue("response", "", {
			...message,
			content: message.content.map((block) => block.type === "thinking" ? {
				type: "thinking",
				byteLength: Buffer.byteLength(block.thinking, "utf8"),
			} : block),
		}, this.#options.capture, this.#options.onError);
		const decisionType = calls.length > 0 ? "tool_calls" : "final";
		const decisionSummary = captureValue(
			"decision_summary",
			"",
			calls.length > 0 ? `Requested ${calls.length} tool call(s): ${calls.map((call) => call.name).join(", ")}.` : "Returned a final answer.",
			this.#options.capture,
			this.#options.onError,
		);
		const usage = message.usage;
		this.#emit({
			type: "llm.call.finished",
			round: llm.round,
			llmCallId: llm.llmCallId,
			assistantTurnId,
			outcome: "success",
			durationMs: this.durationSince(llm.startedAt),
			stopReason: message.stopReason,
			decisionType,
			toolCallCount: calls.length,
			textBlockCount: textBlocks.length,
			thinkingBlockCount: thinkingBlocks.length,
			decisionSummary,
			...(response.mode === "none" ? {} : { response }),
			usage: Object.freeze({
				inputTokens: usage.input,
				outputTokens: usage.output,
				cacheReadTokens: usage.cacheRead,
				cacheWriteTokens: usage.cacheWrite,
				totalTokens: usage.totalTokens,
				...(typeof usage.cost?.total === "number" ? { costUsd: usage.cost.total } : {}),
			}),
		});
		return assistantTurnId;
	}

	observeToolCalls(assistantTurnId: string, calls: readonly ToolCall[]): readonly TracedToolExecution[] {
		if (calls.length === 0) return Object.freeze([]);
		this.#toolCallCount += calls.length;
		return Object.freeze(
			calls.map((call, ordinal) => {
				const execution = new TracedToolExecution(this, assistantTurnId, call, ordinal);
				execution.request();
				return execution;
			}),
		);
	}

	finishLlmError(llm: LlmCallTrace, error: unknown, cancelled: boolean): void {
		this.#emit({
			type: "llm.call.finished",
			round: llm.round,
			llmCallId: llm.llmCallId,
			outcome: cancelled ? "cancelled" : "error",
			durationMs: this.durationSince(llm.startedAt),
			error: this.captureError(error),
		});
	}

	finish(outcome: RunOutcome, error?: unknown): void {
		if (this.#finished) return;
		this.#finished = true;
		this.#emit({
			type: "agent.run.finished",
			outcome,
			durationMs: this.#durationSince(this.#startedMono),
			assistantTurnCount: this.#assistantTurnCount,
			toolCallCount: this.#toolCallCount,
			...(error === undefined ? {} : { error: this.captureError(error) }),
		});
	}

	captureArguments(toolName: string, value: unknown) {
		return captureValue("arguments", toolName, value, this.#options.capture, this.#options.onError);
	}

	captureResult(toolName: string, value: unknown) {
		return captureValue("result", toolName, value, this.#options.capture, this.#options.onError);
	}

	captureError(value: unknown, toolName = ""): CapturedError {
		return captureError(value, this.#options.capture, toolName, this.#options.onError);
	}

	nowMonotonic(): number {
		return this.#options.clock.nowMonotonicMs();
	}

	generateId(kind: TraceIdKind): string {
		return this.#options.ids.generate(kind);
	}

	durationSince(started: number): number {
		return this.#durationSince(started);
	}

	emitTool(event: Omit<ToolCallFinishedEvent, keyof TraceEventBase | "type"> & { readonly type: "tool.call.finished" }): void;
	emitTool(event: Record<string, unknown> & { readonly type: "tool.call.requested" | "tool.call.started" }): void;
	emitTool(event: Record<string, unknown>): void {
		this.#emit(event);
	}

	#durationSince(started: number): number {
		return Math.max(0, this.#options.clock.nowMonotonicMs() - started);
	}

	#emit(event: Record<string, unknown>): void {
		if (
			this.#options.level === "summary" &&
			event.type !== "agent.run.started" &&
			event.type !== "agent.run.finished"
		) return;
		const base: TraceEventBase = {
			schemaVersion: 1,
			eventId: this.#options.ids.generate("event"),
			type: event.type as TraceEvent["type"],
			timeUnixMs: this.#options.clock.nowUnixMs(),
			sequence: ++this.#sequence,
			sessionId: this.#options.sessionId,
			runId: this.runId,
			...(this.#options.correlationId ? { correlationId: this.#options.correlationId } : {}),
			...(this.#options.attributes ? { attributes: this.#options.attributes } : {}),
		};
		const snapshot = deepFreeze({ ...base, ...event }) as TraceEvent;
		try {
			this.#options.sink.emit(snapshot);
		} catch (error) {
			reportTraceError(this.#options.onError, error);
		}
	}
}

export class TracedToolExecution {
	readonly #run: RunTraceRecorder;
	readonly #assistantTurnId: string;
	readonly #executionId: string;
	readonly #call: ToolCall;
	readonly #ordinal: number;
	#requestedAt = 0;
	#startedAt?: number;
	#finished = false;

	constructor(run: RunTraceRecorder, assistantTurnId: string, call: ToolCall, ordinal: number) {
		this.#run = run;
		this.#assistantTurnId = assistantTurnId;
		this.#executionId = run.generateId("tool_execution");
		this.#call = call;
		this.#ordinal = ordinal;
	}

	request(): void {
		this.#requestedAt = this.#run.nowMonotonic();
		this.#run.emitTool({
			type: "tool.call.requested",
			...this.#identity(),
			arguments: this.#run.captureArguments(this.#call.name, this.#call.arguments),
		});
	}

	start(): void {
		if (this.#finished || this.#startedAt !== undefined) return;
		this.#startedAt = this.#run.nowMonotonic();
		this.#run.emitTool({
			type: "tool.call.started",
			...this.#identity(),
			queueDurationMs: this.#run.durationSince(this.#requestedAt),
		});
	}

	finishResult(result: ToolExecutionResult): void {
		this.#finish(result.isError === true ? "error" : "success", result.isError ? "execution" : undefined, {
			result: this.#run.captureResult(this.#call.name, result),
		});
	}

	finishError(stage: ToolFailureStage, error: unknown): void {
		this.#finish("error", stage, { error: this.#run.captureError(error, this.#call.name) });
	}

	finishCancelled(reason: unknown): void {
		this.#finish("cancelled", "cancellation", { error: this.#run.captureError(reason, this.#call.name) });
	}

	finishSkipped(reason: unknown): void {
		this.#finish("skipped", "cancellation", { error: this.#run.captureError(reason, this.#call.name) });
	}

	#identity() {
		return {
			assistantTurnId: this.#assistantTurnId,
			toolExecutionId: this.#executionId,
			toolCallId: this.#call.id,
			toolName: this.#call.name,
			ordinal: this.#ordinal,
			attempt: 1 as const,
		};
	}

	#finish(
		outcome: ToolOutcome,
		failureStage?: ToolFailureStage,
		extra: { readonly result?: ReturnType<RunTraceRecorder["captureResult"]>; readonly error?: CapturedError } = {},
	): void {
		if (this.#finished) return;
		this.#finished = true;
		this.#run.emitTool({
			type: "tool.call.finished",
			...this.#identity(),
			outcome,
			...(failureStage ? { failureStage } : {}),
			totalDurationMs: this.#run.durationSince(this.#requestedAt),
			...(this.#startedAt === undefined
				? {}
				: { executionDurationMs: this.#run.durationSince(this.#startedAt) }),
			...extra,
		});
	}
}
