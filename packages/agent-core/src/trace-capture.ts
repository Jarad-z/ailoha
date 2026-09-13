import { createHash } from "node:crypto";
import { toError } from "./errors.js";
import type { CapturedError, CapturedValue, CaptureMode, TraceCapturePolicy } from "./trace-types.js";

const DEFAULT_MAX_VALUE_BYTES = 32 * 1024;
const MAX_DEPTH = 32;
const MAX_NODES = 20_000;
const BUILTIN_REDACT_KEYS = [
	"authorization",
	"proxy-authorization",
	"cookie",
	"set-cookie",
	"password",
	"passwd",
	"secret",
	"client-secret",
	"api-key",
	"apikey",
	"access-token",
	"refresh-token",
	"private-key",
	"credential",
];

type CaptureKind = "arguments" | "result" | "message" | "request" | "response" | "decision_summary";

interface NormalizationState {
	readonly seen: WeakSet<object>;
	readonly redactKeys: ReadonlySet<string>;
	readonly redactValues: boolean;
	nodes: number;
}

function normalizedKey(value: string): string {
	return value.toLowerCase().replaceAll("_", "").replaceAll("-", "");
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function safeOnError(onError: ((error: Error) => void) | undefined, cause: unknown): void {
	try {
		onError?.(toError(cause));
	} catch {
		// Observability errors never escape into Agent execution.
	}
}

function normalizeValue(value: unknown, state: NormalizationState, depth: number): unknown {
	state.nodes++;
	if (state.nodes > MAX_NODES) return "[TRUNCATED: node limit]";
	if (depth > MAX_DEPTH) return "[TRUNCATED: depth limit]";
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (typeof value === "bigint") return `${value}n`;
	if (typeof value === "undefined") return "[undefined]";
	if (typeof value === "symbol") return `[symbol: ${value.description ?? ""}]`;
	if (typeof value === "function") return `[function: ${value.name || "anonymous"}]`;
	if (typeof value !== "object") return String(value);

	if (state.seen.has(value)) return "[Circular]";
	state.seen.add(value);
	try {
		if (value instanceof Date) return value.toISOString();
		if (value instanceof Error) {
			return {
				name: value.name,
				message: value.message,
				...("code" in value && typeof value.code === "string" ? { code: value.code } : {}),
			};
		}
		if (value instanceof Map) {
			return [...value.entries()].map(([key, item]) => [
				normalizeValue(key, state, depth + 1),
				normalizeValue(item, state, depth + 1),
			]);
		}
		if (value instanceof Set) return [...value].map((item) => normalizeValue(item, state, depth + 1));
		if (Array.isArray(value)) return value.map((item) => normalizeValue(item, state, depth + 1));

		const record = value as Record<string, unknown>;
		if (record.type === "image" && typeof record.data === "string") {
			return {
				type: "image",
				...(typeof record.mimeType === "string" ? { mimeType: record.mimeType } : {}),
				byteLength: byteLength(record.data),
				sha256: hash(record.data),
			};
		}

		const output: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort()) {
			if (state.redactValues && state.redactKeys.has(normalizedKey(key))) {
				output[key] = "[REDACTED]";
				continue;
			}
			try {
				output[key] = normalizeValue(record[key], state, depth + 1);
			} catch (error) {
				output[key] = `[Unserializable: ${toError(error).message}]`;
			}
		}
		return output;
	} finally {
		state.seen.delete(value);
	}
}

function stringify(value: unknown): string {
	return JSON.stringify(value);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
	if (typeof value !== "object" || value === null || seen.has(value)) return value;
	seen.add(value);
	for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
	return Object.freeze(value);
}

function resolvePolicy(policy: TraceCapturePolicy | undefined, toolName: string): TraceCapturePolicy {
	const override = policy?.perTool?.[toolName];
	return { ...policy, ...override, perTool: undefined };
}

function captureMode(kind: CaptureKind, policy: TraceCapturePolicy): CaptureMode {
	switch (kind) {
		case "arguments": return policy.arguments ?? "redacted";
		case "result": return policy.results ?? "metadata";
		case "message": return policy.messages ?? "metadata";
		case "request": return policy.requests ?? "none";
		case "response": return policy.responses ?? "none";
		case "decision_summary": return policy.decisionSummaries ?? "redacted";
	}
}

export function captureValue(
	kind: CaptureKind,
	toolName: string,
	value: unknown,
	policy: TraceCapturePolicy | undefined,
	onError?: (error: Error) => void,
): CapturedValue {
	const resolved = resolvePolicy(policy, toolName);
	const mode = captureMode(kind, resolved);
	if (mode === "none") return Object.freeze({ mode });

	try {
		const customValue = resolved.redact
			? resolved.redact({ toolName, kind, value })
			: value;
		const redactKeys = new Set(
			[...BUILTIN_REDACT_KEYS, ...(resolved.redactKeys ?? [])].map(normalizedKey),
		);
		const normalized = normalizeValue(
			customValue,
			{
				seen: new WeakSet(),
				redactKeys,
				// Platform sensitive keys are never persisted, including in full mode.
				redactValues: mode === "redacted" || mode === "full",
				nodes: 0,
			},
			0,
		);
		const serialized = stringify(normalized);
		const originalByteLength = byteLength(serialized);
		if (mode === "metadata") {
			return Object.freeze({
				mode,
				byteLength: originalByteLength,
				sha256: hash(serialized),
			});
		}

		const limit = resolved.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES;
		if (!Number.isInteger(limit) || limit < 0) throw new RangeError("maxValueBytes must be a non-negative integer.");
		if (originalByteLength <= limit) {
			return Object.freeze({ mode, value: deepFreeze(normalized), byteLength: originalByteLength });
		}
		let preview = Buffer.from(serialized, "utf8").subarray(0, limit).toString("utf8");
		while (byteLength(preview) > limit) preview = Array.from(preview).slice(0, -1).join("");
		return Object.freeze({
			mode,
			value: preview,
			byteLength: byteLength(preview),
			truncated: true,
			originalByteLength,
			sha256: hash(serialized),
		});
	} catch (error) {
		safeOnError(onError, error);
		return Object.freeze({ mode: "metadata" as const });
	}
}

function redactErrorMessage(value: string, keys: readonly string[]): string {
	let output = value;
	for (const key of keys) {
		const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		output = output.replace(new RegExp(`(${escaped}\\s*[:=]\\s*)[^\\s,;]+`, "gi"), "$1[REDACTED]");
	}
	return output;
}

export function captureError(
	value: unknown,
	policy: TraceCapturePolicy | undefined,
	toolName = "",
	onError?: (error: Error) => void,
): CapturedError {
	try {
		const error = toError(value);
		const resolved = resolvePolicy(policy, toolName);
		const keys = [...BUILTIN_REDACT_KEYS, ...(resolved.redactKeys ?? [])];
		let captured: Record<string, unknown> = {
			name: error.name,
			message: redactErrorMessage(error.message, keys),
			...("code" in error && typeof error.code === "string" ? { code: error.code } : {}),
			...("retryable" in error && typeof error.retryable === "boolean" ? { retryable: error.retryable } : {}),
			...(resolved.errors === "stack" && error.stack
				? { stack: redactErrorMessage(error.stack, keys) }
				: {}),
		};
		if (resolved.redact) {
			const redacted = resolved.redact({ toolName, kind: "error", value: captured });
			if (typeof redacted === "object" && redacted !== null) captured = redacted as Record<string, unknown>;
		}
		return Object.freeze({
			name: typeof captured.name === "string" ? captured.name : "Error",
			message: typeof captured.message === "string" ? captured.message : "Trace error capture failed.",
			...(typeof captured.code === "string" ? { code: captured.code } : {}),
			...(typeof captured.stack === "string" ? { stack: captured.stack } : {}),
			...(typeof captured.retryable === "boolean" ? { retryable: captured.retryable } : {}),
		});
	} catch (error) {
		safeOnError(onError, error);
		return Object.freeze({ name: "Error", message: "Trace error capture failed." });
	}
}

export function reportTraceError(onError: ((error: Error) => void) | undefined, cause: unknown): void {
	safeOnError(onError, cause);
}
