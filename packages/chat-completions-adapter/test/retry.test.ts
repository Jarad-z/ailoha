import { describe, expect, it } from "vitest";
import { abortableSleep, decideRetry, normalizeRetryPolicy } from "../src/retry.js";

const signal = new AbortController().signal;

function httpError(status: number, headers: Record<string, string> = {}) {
	return {
		name: "APIError",
		status,
		headers: new Headers(headers),
	};
}

describe("retry policy", () => {
	it("normalizes defaults, disables retries, and rejects unsafe configuration", () => {
		expect(normalizeRetryPolicy(undefined)).toEqual({
			maxAttempts: 3,
			baseDelayMs: 250,
			maxDelayMs: 2_000,
			respectRetryAfter: true,
		});
		expect(normalizeRetryPolicy(false).maxAttempts).toBe(1);
		expect(() => normalizeRetryPolicy({ maxAttempts: 0 })).toThrow(RangeError);
		expect(() => normalizeRetryPolicy({ maxAttempts: 6 })).toThrow(RangeError);
		expect(() => normalizeRetryPolicy({ baseDelayMs: 10, maxDelayMs: 5 })).toThrow(RangeError);
		expect(() => normalizeRetryPolicy({ respectRetryAfter: "yes" as never })).toThrow(TypeError);
	});

	it.each([408, 409, 429, 500, 502, 503, 504])("retries HTTP %s", (status) => {
		const decision = decideRetry({
			error: httpError(status),
			signal,
			attempt: 1,
			policy: normalizeRetryPolicy({ baseDelayMs: 100, maxDelayMs: 100 }),
			runtime: { random: () => 0.5, now: () => 0 },
		});
		expect(decision).toMatchObject({
			retry: true,
			retryable: true,
			exhausted: false,
			event: { status, reason: "http_status", delayMs: 50 },
		});
	});

	it.each([400, 401, 403, 404, 422, 501, 505])("does not retry HTTP %s", (status) => {
		expect(decideRetry({
			error: httpError(status),
			signal,
			attempt: 1,
			policy: normalizeRetryPolicy(undefined),
		}).retry).toBe(false);
	});

	it("honors retry-after-ms and rejects delays above the synchronous cap", () => {
		const policy = normalizeRetryPolicy({ baseDelayMs: 1, maxDelayMs: 1 });
		expect(decideRetry({
			error: httpError(429, { "retry-after-ms": "25" }),
			signal,
			attempt: 1,
			policy,
			runtime: { random: () => 0, now: () => 0 },
		}).event?.delayMs).toBe(25);
		expect(decideRetry({
			error: httpError(429, { "retry-after": "31" }),
			signal,
			attempt: 1,
			policy,
		}).retry).toBe(false);
	});

	it("classifies connection and timeout errors without message matching", () => {
		const policy = normalizeRetryPolicy({ baseDelayMs: 0, maxDelayMs: 0 });
		expect(decideRetry({
			error: { name: "APIConnectionError", cause: { code: "ECONNRESET" } },
			signal,
			attempt: 1,
			policy,
		}).event?.reason).toBe("connection");
		expect(decideRetry({
			error: { name: "APIConnectionTimeoutError" },
			signal,
			attempt: 1,
			policy,
		}).event?.reason).toBe("timeout");
		expect(decideRetry({
			error: new Error("ECONNRESET appears only in text"),
			signal,
			attempt: 1,
			policy,
		}).retry).toBe(false);
	});

	it("marks a transient error exhausted on the final attempt", () => {
		expect(decideRetry({
			error: httpError(503, { "x-request-id": "req-final" }),
			signal,
			attempt: 3,
			policy: normalizeRetryPolicy({ maxAttempts: 3 }),
		})).toEqual({
			retry: false,
			retryable: true,
			exhausted: true,
			requestId: "req-final",
		});
	});

	it("interrupts sleep with the abort reason", async () => {
		const controller = new AbortController();
		const waiting = abortableSleep(10_000, controller.signal);
		controller.abort(new DOMException("cancelled", "AbortError"));
		await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
	});
});
