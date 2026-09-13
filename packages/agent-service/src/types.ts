import type {
	AgentInputMessage,
	SessionOptions,
	ToolRequest,
	TraceEventHub,
	RunTraceStore,
	TraceCapturePolicy,
	TraceSubscription,
} from "@ailoha/agent-core";

export interface ServiceRequestContext {
	readonly ownerId: string;
}

export interface AgentProfile {
	readonly id: string;
	readonly name: string;
	readonly modelId: string;
	readonly systemPrompts: readonly string[];
	readonly tools: readonly ToolRequest[];
	readonly maxTurns?: number;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface CreateAgentProfileInput {
	readonly id?: string;
	readonly name: string;
	readonly modelId: string;
	readonly systemPrompts?: readonly string[];
	readonly tools?: readonly ToolRequest[];
	readonly maxTurns?: number;
}

export interface UpdateAgentProfileInput {
	readonly name?: string;
	readonly modelId?: string;
	readonly systemPrompts?: readonly string[];
	readonly tools?: readonly ToolRequest[];
	readonly maxTurns?: number;
}

export type ServiceSessionStatus = "creating" | "ready" | "closing" | "closed";

export interface ServiceSessionInfo {
	readonly id: string;
	readonly ownerId: string;
	readonly agentProfileId: string;
	readonly title?: string;
	readonly status: ServiceSessionStatus;
	readonly agentStatus?: "idle" | "running" | "compacting";
	readonly activeRunId?: string;
	readonly activeOperationId?: string;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface CreateServiceSessionInput {
	readonly agentProfileId: string;
	readonly title?: string;
	readonly idempotencyKey: string;
}

export type MessageDelivery = "auto" | "prompt" | "steer" | "follow_up";

export interface SendMessageInput {
	readonly sessionId: string;
	readonly message: AgentInputMessage;
	readonly delivery?: MessageDelivery;
	readonly idempotencyKey: string;
}

export interface SendMessageResult {
	readonly operationId: string;
	readonly messageId: string;
	readonly sessionId: string;
	readonly runId: string;
	readonly acceptedAs: Exclude<MessageDelivery, "auto">;
	readonly runStatus: RunStatus;
}

export interface SendRunMessageInput {
	readonly runId: string;
	readonly message: AgentInputMessage;
	readonly delivery: "steer" | "follow_up";
	readonly idempotencyKey: string;
}

export interface ServiceMessage {
	readonly id: string;
	readonly sessionId: string;
	readonly runId: string;
	readonly role: "user" | "assistant";
	readonly content: unknown;
	readonly delivery?: MessageDelivery;
	readonly createdAt: number;
}

export interface MessagePage {
	readonly items: readonly ServiceMessage[];
	readonly nextCursor?: string;
}

export type RunStatus = "running" | "succeeded" | "failed" | "aborted";

export interface RunInfo {
	readonly id: string;
	readonly sessionId: string;
	readonly status: RunStatus;
	readonly startedAt: number;
	readonly finishedAt?: number;
	readonly error?: ServiceError;
}

export type OperationType =
	| "session.create"
	| "message.send"
	| "run.abort"
	| "session.compact"
	| "session.close";

export type OperationStatus = "accepted" | "running" | "succeeded" | "failed" | "aborted";

export interface OperationInfo {
	readonly id: string;
	readonly type: OperationType;
	readonly sessionId?: string;
	readonly runId?: string;
	readonly status: OperationStatus;
	readonly createdAt: number;
	readonly finishedAt?: number;
	readonly result?: unknown;
	readonly error?: ServiceError;
}

export interface ServiceError {
	readonly code: string;
	readonly message: string;
	readonly retryable: boolean;
	readonly details?: Readonly<Record<string, unknown>>;
}

export interface CompactSessionInput {
	readonly sessionId: string;
	readonly idempotencyKey: string;
	readonly signal?: AbortSignal;
}

export interface CompactSessionResult {
	readonly operationId: string;
	readonly sessionId: string;
	readonly status: "running" | "succeeded";
	readonly changed?: boolean;
	readonly beforeTokens?: number;
	readonly afterTokens?: number;
}

export type ServiceEventType =
	| "session.creating"
	| "session.ready"
	| "session.closed"
	| "message.accepted"
	| "run.started"
	| "run.succeeded"
	| "run.failed"
	| "run.aborted"
	| "compact.started"
	| "compact.succeeded"
	| "compact.failed"
	| "compact.aborted";

export interface ServiceEvent {
	readonly id: string;
	readonly type: ServiceEventType;
	readonly timeUnixMs: number;
	readonly ownerId: string;
	readonly sessionId: string;
	readonly operationId?: string;
	readonly runId?: string;
	readonly data?: unknown;
}

export interface ServiceEventRecord {
	readonly cursor: string;
	readonly event: ServiceEvent;
}

export interface ServiceEventSubscription extends AsyncIterable<ServiceEventRecord> {
	close(reason?: unknown): void;
}

export interface ServiceEventPublisher {
	publish(event: ServiceEvent): ServiceEventRecord;
	subscribe(sessionId: string, cursor?: string): ServiceEventSubscription;
	dispose(): void;
}

export interface TranscriptStore {
	append(message: ServiceMessage): void;
	list(sessionId: string, cursor?: string): MessagePage;
}

export interface AgentProfileRegistry {
	create(input: CreateAgentProfileInput): Promise<AgentProfile>;
	get(id: string): Promise<AgentProfile | undefined>;
	list(): Promise<readonly AgentProfile[]>;
	update(id: string, patch: UpdateAgentProfileInput): Promise<AgentProfile>;
	delete(id: string): Promise<boolean>;
}

export interface AgentServiceRuntimeOptions {
	readonly resolveSessionOptions: (
		profile: AgentProfile,
		context: { readonly ownerId: string; readonly sessionId: string },
	) => SessionOptions | Promise<SessionOptions>;
	readonly sessionRuntime?: import("@ailoha/agent-core").SessionRuntime;
	readonly profileRegistry?: AgentProfileRegistry;
	readonly transcriptStore?: TranscriptStore;
	readonly eventPublisher?: ServiceEventPublisher;
	readonly traceHub?: TraceEventHub;
	readonly traceStore?: RunTraceStore;
	readonly traceCapture?: TraceCapturePolicy;
	readonly traceConfig?: AgentServiceTraceConfig;
	readonly generateId?: (kind: "profile" | "session" | "run" | "operation" | "message" | "event") => string;
	readonly clock?: () => number;
	readonly eventReplayCapacity?: number;
	readonly idempotencyTtlMs?: number;
}

export type AgentServiceTraceLevel = "summary" | "execution" | "debug";

export interface AgentServiceTraceConfig {
	readonly enabled: boolean;
	readonly rootDir: string;
	readonly level: AgentServiceTraceLevel;
	readonly captureArguments: import("@ailoha/agent-core").CaptureMode;
	readonly captureResults: import("@ailoha/agent-core").CaptureMode;
	readonly maxValueBytes: number;
	readonly fsyncOnRunFinish: boolean;
	readonly retentionDays: number;
	readonly maxPendingEvents?: number;
}

export interface AgentServiceHttpOptions {
	readonly authenticate: (request: import("node:http").IncomingMessage) =>
		| ServiceRequestContext
		| Promise<ServiceRequestContext>;
	readonly maxBodyBytes?: number;
}

export interface AgentServiceRuntimeApi {
	subscribeSessionTrace(sessionId: string, cursor: string | undefined, context: ServiceRequestContext): TraceSubscription;
	getRunTracePath(runId: string, context: ServiceRequestContext): Promise<string>;
}
