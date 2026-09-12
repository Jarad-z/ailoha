import { randomUUID } from "node:crypto";
import { InvalidSessionIdError } from "./errors.js";
import type { SessionId } from "./types.js";

export function createSessionId(): SessionId {
	return randomUUID();
}

export function validateSessionId(value: unknown): SessionId {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new InvalidSessionIdError("Session ID must be a non-empty string.");
	}
	return value;
}
