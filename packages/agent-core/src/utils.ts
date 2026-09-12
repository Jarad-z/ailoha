import { AgentInputError } from "./errors.js";
import type { AgentInputMessage, AgentMessage } from "./types.js";

export async function awaitWithAbortCheck<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	try {
		return await operation;
	} finally {
		signal.throwIfAborted();
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInputContent(value: unknown): boolean {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	if (value.type === "text") return typeof value.text === "string";
	return value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string";
}

export function assertAgentInputMessage(value: unknown): asserts value is AgentInputMessage {
	if (!isRecord(value) || value.role !== "user") {
		throw new AgentInputError('Agent input messages must have role "user".');
	}
	if (typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp)) {
		throw new AgentInputError("Agent input messages must include a finite timestamp.");
	}
	if (typeof value.content === "string") return;
	if (!Array.isArray(value.content) || !value.content.every(isInputContent)) {
		throw new AgentInputError("Agent input content must be a string or Pi text/image content array.");
	}
}

export function normalizePromptInput(
	input: string | AgentInputMessage | readonly AgentInputMessage[],
): AgentInputMessage[] {
	if (typeof input === "string") return [{ role: "user", content: input, timestamp: Date.now() }];
	const values: readonly unknown[] = Array.isArray(input) ? input : [input];
	const messages: AgentInputMessage[] = [];
	for (const value of values) {
		assertAgentInputMessage(value);
		messages.push(value);
	}
	return messages;
}

export function freezeMessages(messages: readonly AgentMessage[]): readonly AgentMessage[] {
	return Object.freeze([...messages]);
}

export function formatError(value: unknown): string {
	return value instanceof Error ? value.message : typeof value === "string" ? value : String(value);
}
