export class AgentInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentInputError";
	}
}

export class AgentStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentStateError";
	}
}

export class AgentTurnLimitError extends AgentStateError {
	readonly code = "AGENT_TURN_LIMIT";
	readonly maxTurns: number;
	readonly turnCount: number;

	constructor(maxTurns: number, turnCount: number) {
		super(`Agent turn limit reached: ${turnCount}/${maxTurns}.`);
		this.name = "AgentTurnLimitError";
		this.maxTurns = maxTurns;
		this.turnCount = turnCount;
	}
}

export class MessageAdmissionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MessageAdmissionError";
	}
}

export class ModelError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelError";
	}
}

export class ContextWindowExceededError extends ModelError {
	readonly code = "CONTEXT_WINDOW_EXCEEDED";

	constructor(message = "The model context window was exceeded.", options?: ErrorOptions) {
		super(message);
		this.name = "ContextWindowExceededError";
		if (options?.cause !== undefined) this.cause = options.cause;
	}
}

export type WorkspaceContextErrorCode =
	| "WORKSPACE_CWD_INVALID"
	| "WORKSPACE_INSTRUCTIONS_UNREADABLE"
	| "WORKSPACE_INSTRUCTIONS_TOO_LARGE"
	| "WORKSPACE_INSTRUCTIONS_INVALID_UTF8"
	| "WORKSPACE_INSTRUCTIONS_NOT_REGULAR_FILE";

export class WorkspaceContextError extends Error {
	readonly code: WorkspaceContextErrorCode;
	readonly fileName: string;

	constructor(
		code: WorkspaceContextErrorCode,
		message: string,
		options: ErrorOptions & { readonly fileName?: string } = {},
	) {
		super(message, options);
		this.name = "WorkspaceContextError";
		this.code = code;
		this.fileName = options.fileName ?? "AGENTS.md";
	}
}

export type ContextCompactionErrorCode =
	| "CONTEXT_INPUT_TOO_LARGE"
	| "COMPACTION_INVALID_SUMMARY"
	| "COMPACTION_INSUFFICIENT_GAIN"
	| "CONTEXT_REVISION_CONFLICT";

export class ContextCompactionError extends Error {
	readonly code: ContextCompactionErrorCode;

	constructor(code: ContextCompactionErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ContextCompactionError";
		this.code = code;
	}
}

export function isContextWindowExceededError(error: unknown): boolean {
	return (
		error instanceof ContextWindowExceededError ||
		(typeof error === "object" && error !== null && "code" in error && error.code === "CONTEXT_WINDOW_EXCEEDED")
	);
}

export class SessionRuntimeStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionRuntimeStateError";
	}
}

export class InvalidSessionIdError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidSessionIdError";
	}
}

export class DuplicateSessionIdError extends Error {
	readonly sessionId: string;

	constructor(sessionId: string) {
		super(`Session ID is already in use: ${sessionId}`);
		this.name = "DuplicateSessionIdError";
		this.sessionId = sessionId;
	}
}

export class SessionCapacityError extends Error {
	readonly maxSessions: number;

	constructor(maxSessions: number) {
		super(`Session Runtime capacity reached: ${maxSessions}`);
		this.name = "SessionCapacityError";
		this.maxSessions = maxSessions;
	}
}

export class InvalidTraceCursorError extends Error {
	constructor(message = "Trace cursor is invalid.") {
		super(message);
		this.name = "InvalidTraceCursorError";
	}
}

export class TraceCursorExpiredError extends Error {
	readonly earliestAvailableCursor?: string;
	readonly latestCursor?: string;

	constructor(earliestAvailableCursor?: string, latestCursor?: string) {
		super("Trace cursor is outside the available replay window.");
		this.name = "TraceCursorExpiredError";
		this.earliestAvailableCursor = earliestAvailableCursor;
		this.latestCursor = latestCursor;
	}
}

export class TraceReplayLimitError extends Error {
	readonly requestedEvents: number;
	readonly limit: number;

	constructor(requestedEvents: number, limit: number) {
		super(`Trace replay requires ${requestedEvents} events; subscription buffer limit is ${limit}.`);
		this.name = "TraceReplayLimitError";
		this.requestedEvents = requestedEvents;
		this.limit = limit;
	}
}

export class TraceSubscriptionOverflowError extends Error {
	readonly subscriptionId: string;

	constructor(subscriptionId: string) {
		super(`Trace subscription buffer overflowed: ${subscriptionId}`);
		this.name = "TraceSubscriptionOverflowError";
		this.subscriptionId = subscriptionId;
	}
}

export class TraceHubStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TraceHubStateError";
	}
}

export function toError(value: unknown): Error {
	if (value instanceof Error) return value;
	return new Error(typeof value === "string" ? value : String(value));
}

export function isAbortError(value: unknown): boolean {
	return value instanceof Error && value.name === "AbortError";
}

export function createAbortError(message = "The operation was aborted."): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}
