import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	TSchema,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { ToolManager } from "./tool-manager.js";
import type { TraceOptions } from "./trace-types.js";

export type AgentModel = Model<Api>;
export type AgentMessage = Message;
export type AgentInputMessage = UserMessage;
export type AgentAssistantMessage = AssistantMessage;
export type AgentToolCall = ToolCall;
export type AgentToolResultMessage = ToolResultMessage<unknown>;
export type AgentTextContent = TextContent;
export type AgentImageContent = ImageContent;
export type AgentToolSchema = TSchema;
export type SystemPrompt = string;
export type SessionId = string;

export interface ToolRequest {
	readonly name: string;
	readonly options?: Readonly<Record<string, unknown>>;
}

export interface ToolExecutionResult {
	readonly content: string | readonly (TextContent | ImageContent)[];
	readonly details?: unknown;
	readonly isError?: boolean;
}

export interface ToolInitContext {
	readonly sessionId: SessionId;
	readonly model: AgentModel;
	readonly signal: AbortSignal;
}

export interface ToolExecutionContext {
	readonly sessionId: SessionId;
	readonly model: AgentModel;
	readonly context: AgentContext;
	readonly signal: AbortSignal;
}

export interface AgentTool<TParameters extends TSchema = TSchema> extends Tool<TParameters> {
	execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult>;
	dispose?(): void | Promise<void>;
}

export type ToolFactory = (request: ToolRequest, context: ToolInitContext) => AgentTool | Promise<AgentTool>;

export interface AgentContext {
	readonly systemPrompt: string;
	readonly messages: readonly AgentMessage[];
	readonly tools: readonly AgentTool[];
}

export interface BeginRunContextRequest {
	readonly promptMessages: readonly AgentInputMessage[];
	readonly tools: readonly AgentTool[];
	readonly signal: AbortSignal;
}

export interface ContextSnapshot {
	readonly systemPrompts: readonly SystemPrompt[];
	readonly messages: readonly AgentMessage[];
}

export type CompactReason = "before_llm" | "llm_error" | "manual";

export interface CompactRequest {
	readonly reason: CompactReason;
	readonly context: AgentContext;
	readonly error?: Error;
	readonly signal: AbortSignal;
}

export interface CompactResult {
	readonly changed: boolean;
	readonly beforeTokens?: number;
	readonly afterTokens?: number;
	readonly trigger?: CompactionTrigger;
	readonly skipReason?: string;
	readonly checkpointId?: string;
	readonly targetMissed?: boolean;
	readonly summaryCallCount?: number;
}

export interface ManualCompactRequest {
	readonly signal: AbortSignal;
}

export interface ContextManager {
	readonly maxTurns: number;
	readonly turnCount: number;
	readonly canCompact?: boolean;
	consumeTurn(): void;
	beginRun(request: BeginRunContextRequest): Promise<AgentContext>;
	append(context: AgentContext, messages: AgentMessage | readonly AgentMessage[]): void;
	compact(request: CompactRequest): Promise<CompactResult>;
	compactCurrent(request: ManualCompactRequest): Promise<CompactResult>;
	snapshot(): ContextSnapshot;
}

export interface ModelRunner {
	run(context: AgentContext, options: { readonly signal: AbortSignal }): Promise<AgentAssistantMessage>;
}

export type AgentStatus = "idle" | "running" | "compacting";

export interface AgentCompactOptions {
	readonly signal?: AbortSignal;
}

export interface AgentState {
	readonly model: AgentModel;
	status: AgentStatus;
	activeAssistantMessage?: AgentAssistantMessage;
	lastError?: Error;
}

export interface AgentOptions {
	readonly sessionId: SessionId;
	readonly model: AgentModel;
	readonly modelRunner: ModelRunner;
	readonly contextManager: ContextManager;
	readonly toolManager: ToolManager;
	readonly trace?: false | TraceOptions;
}

export interface RunResult {
	readonly runId: string;
	readonly messages: readonly AgentMessage[];
	readonly finalAssistantMessage?: AgentAssistantMessage;
}

export interface CompactorInput {
	readonly reason: CompactReason;
	readonly systemPrompt: string;
	readonly messages: readonly AgentMessage[];
	readonly error?: Error;
	readonly signal: AbortSignal;
}

export interface CompactorOutput {
	readonly messages: readonly AgentMessage[];
	readonly beforeTokens?: number;
	readonly afterTokens?: number;
}

export type Compactor = (input: CompactorInput) => CompactorOutput | undefined | Promise<CompactorOutput | undefined>;

export type CompactionTrigger = "threshold" | "hard_limit" | "overflow" | "manual";

export interface ContextCheckpointItem {
	readonly text: string;
	readonly sourceIds: readonly string[];
}

export interface ContextCheckpointDecision extends ContextCheckpointItem {
	readonly status: "active" | "superseded";
}

export interface ContextCheckpointProgress {
	readonly action: string;
	readonly status: "done" | "failed" | "pending";
	readonly evidence: string;
	readonly sourceIds: readonly string[];
}

export interface ContextCheckpointFact extends ContextCheckpointItem {
	readonly certainty: "observed" | "user_stated" | "inferred";
}

export interface ContextCheckpointArtifact {
	readonly reference: string;
	readonly description: string;
	readonly sourceIds: readonly string[];
}

export interface ContextCheckpoint {
	readonly version: 1;
	readonly objective: string;
	readonly userConstraints: readonly ContextCheckpointItem[];
	readonly decisions: readonly ContextCheckpointDecision[];
	readonly progress: readonly ContextCheckpointProgress[];
	readonly nextSteps: readonly string[];
	readonly criticalFacts: readonly ContextCheckpointFact[];
	readonly artifacts: readonly ContextCheckpointArtifact[];
	readonly openQuestions: readonly string[];
}

export interface ContextTokenEstimate {
	readonly inputTokens: number;
	readonly projectionKey: string;
}

export interface ContextTokenEstimator {
	estimate(input: {
		readonly model: AgentModel;
		readonly context: AgentContext;
		readonly purpose: "agent" | "summary";
	}): ContextTokenEstimate;
}

export interface SummaryUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens?: number;
	readonly cacheWriteTokens?: number;
	readonly reasoningTokens?: number;
	readonly totalTokens: number;
}

export interface SummaryRunnerInput {
	readonly systemPrompt: string;
	readonly data: string;
	readonly maxOutputTokens: number;
	readonly signal: AbortSignal;
}

export interface SummaryRunnerResult {
	readonly text: string;
	readonly stopReason: "stop" | "length";
	readonly usage?: SummaryUsage;
}

export interface SummaryRunner {
	run(input: SummaryRunnerInput): Promise<SummaryRunnerResult>;
}

export interface ContextCompactionOptions {
	readonly model: AgentModel;
	readonly requestOutputTokens: number;
	readonly autoCompactTokenLimit?: number;
	readonly targetInputTokens?: number;
	readonly safetyMarginTokens?: number;
	readonly headroomTokens?: number;
	readonly keepRecentSteps?: number;
	readonly summaryMaxOutputTokens?: number;
	readonly tokenEstimator: ContextTokenEstimator;
	readonly summaryRunner: SummaryRunner;
	readonly additionalSummaryInstructions?: string;
}

export interface DefaultContextManagerOptions {
	readonly systemPrompts?: readonly SystemPrompt[];
	readonly messages?: readonly AgentMessage[];
	readonly maxTurns?: number;
	readonly compactor?: Compactor;
	readonly compaction?: ContextCompactionOptions;
	readonly prepareRun?: (request: BeginRunContextRequest, snapshot: ContextSnapshot) => void | Promise<void>;
	readonly joinSystemPrompts?: (prompts: readonly SystemPrompt[]) => string;
}
