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
