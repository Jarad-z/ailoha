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

export type CompactReason = "before_llm" | "llm_error";

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
}

export interface ContextManager {
	beginRun(request: BeginRunContextRequest): Promise<AgentContext>;
	append(context: AgentContext, messages: AgentMessage | readonly AgentMessage[]): void;
	compact(request: CompactRequest): Promise<CompactResult>;
	snapshot(): ContextSnapshot;
}

export interface ModelRunner {
	run(context: AgentContext, options: { readonly signal: AbortSignal }): Promise<AgentAssistantMessage>;
}

export type AgentStatus = "idle" | "running";

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
}

export interface RunResult {
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

export interface DefaultContextManagerOptions {
	readonly systemPrompts?: readonly SystemPrompt[];
	readonly messages?: readonly AgentMessage[];
	readonly compactor?: Compactor;
	readonly prepareRun?: (request: BeginRunContextRequest, snapshot: ContextSnapshot) => void | Promise<void>;
	readonly joinSystemPrompts?: (prompts: readonly SystemPrompt[]) => string;
}
