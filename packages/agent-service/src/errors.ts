import {
	AgentInputError,
	AgentStateError,
	AgentTurnLimitError,
	InvalidSessionIdError,
	MessageAdmissionError,
	SessionCapacityError,
	SessionRuntimeStateError,
	isAbortError,
} from "@ailoha/agent-core";
import type { ServiceError } from "./types.js";

export class AgentServiceError extends Error {
	readonly serviceError: ServiceError;
	readonly httpStatus: number;

	constructor(serviceError: ServiceError, httpStatus: number, options?: ErrorOptions) {
		super(serviceError.message, options);
		this.name = "AgentServiceError";
		this.serviceError = Object.freeze(serviceError);
		this.httpStatus = httpStatus;
	}
}

export function serviceFailure(
	code: string,
	message: string,
	httpStatus: number,
	retryable = false,
	details?: Readonly<Record<string, unknown>>,
): AgentServiceError {
	return new AgentServiceError({ code, message, retryable, ...(details ? { details } : {}) }, httpStatus);
}

export function mapServiceError(cause: unknown): AgentServiceError {
	if (cause instanceof AgentServiceError) return cause;
	if (cause instanceof AgentInputError || cause instanceof InvalidSessionIdError || cause instanceof TypeError) {
		return serviceFailure("invalid_request", "The request is invalid.", 400);
	}
	if (cause instanceof AgentTurnLimitError) {
		return serviceFailure("agent_turn_limit_reached", "The Agent turn limit has been reached.", 409, false, {
			maxTurns: cause.maxTurns,
			turnCount: cause.turnCount,
		});
	}
	if (cause instanceof MessageAdmissionError) {
		return serviceFailure("message_not_admitted", "The Agent cannot accept this message in its current phase.", 409);
	}
	if (cause instanceof AgentStateError) {
		return serviceFailure("agent_already_running", "The Agent cannot accept this operation in its current state.", 409);
	}
	if (cause instanceof SessionCapacityError) {
		return serviceFailure("session_capacity_reached", "The Session capacity has been reached.", 429, true);
	}
	if (cause instanceof SessionRuntimeStateError) {
		return serviceFailure("runtime_unavailable", "The Agent Service Runtime is unavailable.", 503, true);
	}
	if (isAbortError(cause)) return serviceFailure("operation_aborted", "The operation was aborted.", 409, true);
	return serviceFailure("operation_failed", "The operation failed.", 500, true);
}
