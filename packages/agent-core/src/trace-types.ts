export type CaptureMode = "none" | "metadata" | "redacted" | "full";
export type TraceLevel = "summary" | "execution" | "debug";

export interface CapturedValue {
	readonly mode: CaptureMode;
	readonly value?: unknown;
	readonly byteLength?: number;
	readonly sha256?: string;
	readonly truncated?: boolean;
	readonly originalByteLength?: number;
}

export interface CapturedError {
	readonly name: string;
	readonly code?: string;
	readonly message: string;
	readonly stack?: string;
	readonly retryable?: boolean;
}

export interface TraceEventBase {
	readonly schemaVersion: 1;
	readonly eventId: string;
	readonly type: TraceEventType;
	readonly timeUnixMs: number;
	readonly sequence: number;
	readonly sessionId: string;
	readonly runId: string;
	readonly correlationId?: string;
	readonly round?: number;
	readonly llmCallId?: string;
	readonly assistantTurnId?: string;
	readonly toolExecutionId?: string;
	readonly operationId?: string;
	readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export type TraceEventType =
	| "agent.run.started"
	| "agent.message.admitted"
	| "context.prepared"
	| "context.compact.started"
	| "context.compact.finished"
	| "llm.call.started"
	| "llm.call.finished"
	| "agent.run.finished"
	| "tool.call.requested"
	| "tool.call.started"
	| "tool.call.finished";

export interface RunStartedEvent extends TraceEventBase {
	readonly type: "agent.run.started";
	readonly inputMessageCount: number;
	readonly model: {
		readonly provider?: string;
		readonly id: string;
	};
}

export type RunOutcome = "success" | "error" | "cancelled";

export interface RunFinishedEvent extends TraceEventBase {
	readonly type: "agent.run.finished";
	readonly outcome: RunOutcome;
	readonly durationMs: number;
	readonly assistantTurnCount: number;
	readonly toolCallCount: number;
	readonly error?: CapturedError;
}

export interface AgentMessageAdmittedEvent extends TraceEventBase {
	readonly type: "agent.message.admitted";
	readonly delivery: "steer" | "follow_up";
	readonly message: CapturedValue;
}

export interface ContextPreparedEvent extends TraceEventBase {
	readonly type: "context.prepared";
	readonly systemPromptCount: number;
	readonly workspaceInstructionsLoaded?: boolean;
	readonly workspaceInstructionsBytes?: number;
	readonly workspaceInstructionsSha256?: `sha256:${string}`;
	readonly toolCount: number;
	readonly historyMessageCount: number;
	readonly inputMessageCount: number;
	readonly totalMessageCount: number;
	readonly estimatedTokens?: number;
	readonly contextSha256: string;
}

export interface ContextCompactStartedEvent extends TraceEventBase {
	readonly type: "context.compact.started";
	readonly compactId: string;
	readonly reason: "before_llm" | "llm_error" | "manual";
	readonly messageCount: number;
	readonly estimatedTokens?: number;
}

export interface ContextCompactFinishedEvent extends TraceEventBase {
	readonly type: "context.compact.finished";
	readonly compactId: string;
	readonly outcome: "changed" | "unchanged" | "error" | "cancelled";
	readonly durationMs: number;
	readonly beforeMessageCount: number;
	readonly afterMessageCount?: number;
	readonly beforeTokens?: number;
	readonly afterTokens?: number;
	readonly error?: CapturedError;
}

export interface LlmCallStartedEvent extends TraceEventBase {
	readonly type: "llm.call.started";
	readonly round: number;
	readonly llmCallId: string;
	readonly model: { readonly provider?: string; readonly id: string };
	readonly messageCount: number;
	readonly estimatedInputTokens?: number;
	readonly toolCount: number;
	readonly request?: CapturedValue;
}

export interface LlmUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens?: number;
	readonly cacheWriteTokens?: number;
	readonly totalTokens: number;
	readonly costUsd?: number;
}

export interface LlmCallFinishedEvent extends TraceEventBase {
	readonly type: "llm.call.finished";
	readonly round: number;
	readonly llmCallId: string;
	readonly outcome: "success" | "error" | "cancelled";
	readonly durationMs: number;
	readonly stopReason?: string;
	readonly decisionType?: "final" | "tool_calls";
	readonly toolCallCount?: number;
	readonly textBlockCount?: number;
	readonly thinkingBlockCount?: number;
	readonly decisionSummary?: CapturedValue;
	readonly response?: CapturedValue;
	readonly usage?: LlmUsage;
	readonly error?: CapturedError;
}

interface ToolCallEventBase extends TraceEventBase {
	readonly assistantTurnId: string;
	readonly toolExecutionId: string;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly ordinal: number;
	readonly attempt: 1;
}

export interface ToolCallRequestedEvent extends ToolCallEventBase {
	readonly type: "tool.call.requested";
	readonly arguments: CapturedValue;
}

export interface ToolCallStartedEvent extends ToolCallEventBase {
	readonly type: "tool.call.started";
	readonly queueDurationMs: number;
}

export type ToolOutcome = "success" | "error" | "cancelled" | "skipped";
export type ToolFailureStage = "lookup" | "validation" | "execution" | "cancellation";

export interface ToolCallFinishedEvent extends ToolCallEventBase {
	readonly type: "tool.call.finished";
	readonly outcome: ToolOutcome;
	readonly failureStage?: ToolFailureStage;
	readonly totalDurationMs: number;
	readonly executionDurationMs?: number;
	readonly result?: CapturedValue;
	readonly error?: CapturedError;
}

export type TraceEvent =
	| RunStartedEvent
	| AgentMessageAdmittedEvent
	| ContextPreparedEvent
	| ContextCompactStartedEvent
	| ContextCompactFinishedEvent
	| LlmCallStartedEvent
	| LlmCallFinishedEvent
	| RunFinishedEvent
	| ToolCallRequestedEvent
	| ToolCallStartedEvent
	| ToolCallFinishedEvent;

export interface TraceSink {
	emit(event: TraceEvent): void;
	flush?(): Promise<void>;
	dispose?(): Promise<void>;
}

export interface TraceCapturePolicy {
	readonly messages?: CaptureMode;
	readonly requests?: CaptureMode;
	readonly responses?: CaptureMode;
	readonly decisionSummaries?: CaptureMode;
	readonly arguments?: CaptureMode;
	readonly results?: CaptureMode;
	readonly errors?: "message" | "stack";
	readonly maxValueBytes?: number;
	readonly redactKeys?: readonly string[];
	readonly perTool?: Readonly<Record<string, Partial<TraceCapturePolicy>>>;
	readonly redact?: (input: {
		readonly toolName: string;
		readonly kind: "arguments" | "result" | "message" | "request" | "response" | "decision_summary" | "error";
		readonly value: unknown;
	}) => unknown;
}

export interface TraceClock {
	nowUnixMs(): number;
	nowMonotonicMs(): number;
}

export type TraceIdKind = "event" | "run" | "llm_call" | "assistant_turn" | "tool_execution" | "compact" | "subscription" | "hub";

export interface TraceIdGenerator {
	generate(kind: TraceIdKind): string;
}

export interface TraceOptions {
	readonly enabled?: boolean;
	readonly level?: TraceLevel;
	readonly sink: TraceSink;
	readonly sinkOwnership?: "session" | "external";
	readonly capture?: TraceCapturePolicy;
	readonly sessionAttributes?: Readonly<Record<string, string | number | boolean>>;
	readonly onError?: (error: Error) => void;
	readonly clock?: TraceClock;
	readonly idGenerator?: TraceIdGenerator;
}

export interface AgentRunOptions {
	readonly runId?: string;
	readonly correlationId?: string;
	readonly traceAttributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface AgentMessageAdmissionOptions {
	readonly operationId?: string;
}

export type TraceCursor = string;

export interface TraceRecord {
	readonly kind: "event";
	readonly cursor: TraceCursor;
	readonly event: TraceEvent;
}

export interface TraceGap {
	readonly kind: "gap";
	readonly droppedCount: number;
	readonly afterCursor?: TraceCursor;
	readonly nextCursor: TraceCursor;
}

export type TraceDelivery = TraceRecord | TraceGap;

export interface TraceFilter {
	readonly sessionIds?: readonly string[];
	readonly runIds?: readonly string[];
	readonly eventTypes?: readonly TraceEventType[];
	readonly toolNames?: readonly string[];
	readonly outcomes?: readonly (RunOutcome | ToolOutcome)[];
}

export type TraceSubscriptionStart =
	| { readonly mode: "latest" }
	| { readonly mode: "after"; readonly cursor: TraceCursor }
	| { readonly mode: "earliest_available" };

export interface TraceSubscriptionOptions {
	readonly start?: TraceSubscriptionStart;
	readonly filter?: TraceFilter;
	readonly bufferCapacity?: number;
	readonly overflow?: "close" | "drop_oldest";
	readonly signal?: AbortSignal;
}

export interface TraceSubscriptionSnapshot {
	readonly id: string;
	readonly status: "open" | "closed";
	readonly deliveredEvents: number;
	readonly filteredEvents: number;
	readonly droppedEvents: number;
	readonly lastDeliveredCursor?: TraceCursor;
	readonly closeReason?: string;
}

export interface TraceSubscription extends AsyncIterable<TraceDelivery> {
	readonly id: string;
	close(reason?: unknown): void;
	snapshot(): TraceSubscriptionSnapshot;
}

export interface TraceSource {
	subscribe(options?: TraceSubscriptionOptions): TraceSubscription;
}

export interface TraceSinkStats {
	readonly acceptedEvents: number;
	readonly droppedEvents: number;
	readonly writeErrors: number;
}

export interface TraceEventHubOptions {
	readonly replayCapacity?: number;
	readonly defaultSubscriberBufferCapacity?: number;
	readonly sinks?: readonly TraceSink[];
	readonly idGenerator?: TraceIdGenerator;
	readonly onError?: (error: Error) => void;
}

export interface JsonlTraceSinkOptions {
	readonly path: string;
	readonly maxPendingEvents?: number;
	readonly onError?: (error: Error) => void;
}

export interface PartitionedJsonlTraceSinkOptions {
	readonly rootDir: string;
	readonly maxPendingEvents?: number;
	readonly fsyncOnRunFinish?: boolean;
	readonly onError?: (error: Error) => void;
}

export interface PartitionedTraceSinkStats extends TraceSinkStats {
	readonly openRunFiles: number;
	readonly completedRunFiles: number;
	readonly incompleteRunFiles: number;
	readonly flushDurationMs: number;
}

export interface RunTraceStore {
	completedTracePath(sessionId: string, runId: string): Promise<string | undefined>;
}
