import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { captureValue } from "../src/trace-capture.js";

describe("Trace payload capture", () => {
	it("recursively redacts platform sensitive keys even in full mode", () => {
		const captured = captureValue("arguments", "tool", {
			authorization: "Bearer canary",
			nested: { api_key: "key-canary", safe: "visible" },
		}, { arguments: "full" });
		expect(captured).toMatchObject({
			mode: "full",
			value: { authorization: "[REDACTED]", nested: { api_key: "[REDACTED]", safe: "visible" } },
		});
		expect(JSON.stringify(captured)).not.toContain("canary");
	});

	it("truncates UTF-8 safely and preserves the original hash and byte size", () => {
		const value = { text: "你好世界".repeat(20) };
		const serialized = JSON.stringify(value);
		const captured = captureValue("result", "tool", value, { results: "redacted", maxValueBytes: 17 });
		expect(captured.truncated).toBe(true);
		expect(captured.byteLength).toBeLessThanOrEqual(17);
		expect(captured.originalByteLength).toBe(Buffer.byteLength(serialized, "utf8"));
		expect(captured.sha256).toBe(createHash("sha256").update(serialized).digest("hex"));
	});
});
