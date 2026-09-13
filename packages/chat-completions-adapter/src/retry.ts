import type { RetryEvent, RetryPolicy } from "./types.js";

const RETRYABLE_HTTP_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);
const CONNECTION_ERROR_CODES = new Set([
	"EAI_AGAIN",
	"ECONNREFUSED",
	"ECONNRESET",
	"ENETDOWN",
	"ENETUNREACH",
	"ENOTFOUND",
	"EPIPE",
	"ETIMEDOUT",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_SOCKET",
]);
const MAX_PROVIDER_DELAY_MS = 30_000;

export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
	maxAttempts: 3,
	baseDelayMs: 250,
	maxDelayMs: 2_000,
	respectRetryAfter: true,
});

export interface RetryRuntime {
	readonly sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
	readonly random: () => number;
	readonly now: () => number;
}

export interface RetryDecision {
	readonly retry: boolean;
	readonly retryable: boolean;
	readonly exhausted: boolean;
	readonly requestId?: string;
	readonly event?: RetryEvent;
}

function finiteNonNegative(value: number, label: string): number {
	if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be a non-negative finite number.`);
	return value;
}

export function normalizeRetryPolicy(input: false | Partial<RetryPolicy> | undefined): Readonly<RetryPolicy> {
	if (input === false) return Object.freeze({ ...DEFAULT_RETRY_POLICY, maxAttempts: 1 });
	const maxAttempts = input?.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts;
	if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
		throw new RangeError("retry.maxAttempts must be an integer between 1 and 5.");
	}
	const baseDelayMs = finiteNonNegative(input?.baseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs, "retry.baseDelayMs");
	const maxDelayMs = finiteNonNegative(input?.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs, "retry.maxDelayMs");
	if (baseDelayMs > maxDelayMs) throw new RangeError("retry.baseDelayMs must not exceed retry.maxDelayMs.");
	const respectRetryAfter = input?.respectRetryAfter ?? DEFAULT_RETRY_POLICY.respectRetryAfter;
	if (typeof respectRetryAfter !== "boolean") throw new TypeError("retry.respectRetryAfter must be a boolean.");
	return Object.freeze({
		maxAttempts,
		baseDelayMs,
		maxDelayMs,
		respectRetryAfter,
	});
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function errorChain(error: unknown): readonly Record<string, unknown>[] {
	const chain: Record<string, unknown>[] = [];
	let current = objectValue(error);
	const seen = new Set<object>();
	while (current && chain.length < 4 && !seen.has(current)) {
		seen.add(current);
		chain.push(current);
		current = objectValue(current.cause);
	}
	return chain;
}

function statusOf(error: unknown): number | undefined {
	for (const item of errorChain(error)) {
		if (typeof item.status === "number" && Number.isInteger(item.status)) return item.status;
	}
	return undefined;
}

function header(error: unknown, name: string): string | undefined {
	for (const item of errorChain(error)) {
		const headers = item.headers;
		if (headers instanceof Headers) return headers.get(name) ?? undefined;
		const record = objectValue(headers);
		if (!record) continue;
		const value = Object.entries(record).find(([key]) => key.toLowerCase() === name)?.[1];
		if (typeof value === "string") return value;
	}
	return undefined;
}

function requestIdOf(error: unknown): string | undefined {
	for (const item of errorChain(error)) {
		if (typeof item.request_id === "string") return item.request_id;
		if (typeof item.requestID === "string") return item.requestID;
	}
	return header(error, "x-request-id") ?? header(error, "x-ds-request-id");
}

function retryAfterMs(error: unknown, now: number): number | undefined {
	const milliseconds = header(error, "retry-after-ms");
	if (milliseconds !== undefined) {
		const parsed = Number(milliseconds);
		if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	}
	const retryAfter = header(error, "retry-after");
	if (retryAfter === undefined) return undefined;
	const seconds = Number(retryAfter);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
	const date = Date.parse(retryAfter);
	return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function transientKind(error: unknown, status: number | undefined): RetryEvent["reason"] | undefined {
	if (status !== undefined) return RETRYABLE_HTTP_STATUSES.has(status) ? "http_status" : undefined;
	for (const item of errorChain(error)) {
		const name = typeof item.name === "string" ? item.name : "";
		const code = typeof item.code === "string" ? item.code.toUpperCase() : "";
		if (name === "APIConnectionTimeoutError" || name === "TimeoutError" || code.includes("TIMEOUT")) return "timeout";
		if (name === "APIConnectionError" || CONNECTION_ERROR_CODES.has(code)) return "connection";
	}
	return undefined;
}

export function decideRetry(input: {
	readonly error: unknown;
	readonly signal: AbortSignal;
	readonly attempt: number;
	readonly policy: Readonly<RetryPolicy>;
	readonly runtime?: Pick<RetryRuntime, "random" | "now">;
}): RetryDecision {
	if (input.signal.aborted) return { retry: false, retryable: false, exhausted: false };
	const chain = errorChain(input.error);
	if (chain.some((item) => item.name === "AbortError")) {
		return { retry: false, retryable: false, exhausted: false };
	}
	const status = statusOf(input.error);
	const reason = transientKind(input.error, status);
	if (!reason) return { retry: false, retryable: false, exhausted: false };
	const requestId = requestIdOf(input.error);
	if (input.attempt >= input.policy.maxAttempts) {
		return { retry: false, retryable: true, exhausted: true, ...(requestId ? { requestId } : {}) };
	}

	const runtime = input.runtime ?? { random: Math.random, now: Date.now };
	const providerDelay = input.policy.respectRetryAfter ? retryAfterMs(input.error, runtime.now()) : undefined;
	if (providerDelay !== undefined && providerDelay > MAX_PROVIDER_DELAY_MS) {
		return { retry: false, retryable: true, exhausted: false, ...(requestId ? { requestId } : {}) };
	}
	const cap = Math.min(input.policy.maxDelayMs, input.policy.baseDelayMs * 2 ** (input.attempt - 1));
	const random = Math.min(Math.max(runtime.random(), 0), 0.999999999);
	const delayMs = providerDelay ?? Math.floor(random * (cap + 1));
	return {
		retry: true,
		retryable: true,
		exhausted: false,
		...(requestId ? { requestId } : {}),
		event: Object.freeze({
			attempt: input.attempt,
			nextAttempt: input.attempt + 1,
			delayMs,
			reason,
			...(status === undefined ? {} : { status }),
			...(requestId ? { requestId } : {}),
		}),
	};
}

export function abortableSleep(delayMs: number, signal: AbortSignal): Promise<void> {
	signal.throwIfAborted();
	if (delayMs === 0) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, delayMs);
		const abort = () => {
			clearTimeout(timeout);
			reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
		};
		signal.addEventListener("abort", abort, { once: true });
	});
}
