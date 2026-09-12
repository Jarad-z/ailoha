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
