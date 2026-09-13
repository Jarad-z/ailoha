import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupAgentServiceTraces, loadAgentServiceTraceConfig } from "../src/index.js";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

describe("Agent Service Trace configuration", () => {
	it("loads safe execution defaults and resolves TRACE_DIR", () => {
		const config = loadAgentServiceTraceConfig({}, "D:/service-root");
		expect(config).toMatchObject({
			enabled: true,
			rootDir: "D:\\service-root\\data\\traces",
			level: "execution",
			captureArguments: "redacted",
			captureResults: "redacted",
			maxValueBytes: 4_096,
			fsyncOnRunFinish: false,
			retentionDays: 30,
		});
	});

	it("rejects invalid environment values", () => {
		expect(() => loadAgentServiceTraceConfig({ TRACE_LEVEL: "verbose" })).toThrow("TRACE_LEVEL");
		expect(() => loadAgentServiceTraceConfig({ TRACE_MAX_VALUE_BYTES: "-1" })).toThrow("TRACE_MAX_VALUE_BYTES");
		expect(() => loadAgentServiceTraceConfig({ TRACE_CAPTURE_RESULTS: "raw" })).toThrow("TRACE_CAPTURE_RESULTS");
	});

	it("deletes only expired Trace files and preserves unrelated files", async () => {
		const rootDir = await mkdtemp(join(tmpdir(), "ailoha-retention-"));
		directories.push(rootDir);
		const directory = join(rootDir, "2026-01-01", "session_a");
		await mkdir(directory, { recursive: true });
		const oldComplete = join(directory, "run_old.jsonl");
		const oldPart = join(directory, "run_crash.jsonl.part");
		const recent = join(directory, "run_recent.jsonl");
		const unrelated = join(directory, "notes.txt");
		await Promise.all([oldComplete, oldPart, recent, unrelated].map(async (path) => await writeFile(path, "x")));
		const now = new Date("2026-09-12T00:00:00Z").getTime();
		const old = new Date("2026-07-01T00:00:00Z");
		await utimes(oldComplete, old, old);
		await utimes(oldPart, old, old);

		await expect(cleanupAgentServiceTraces({ rootDir, retentionDays: 30 }, now)).resolves.toEqual({
			deletedCompleted: 1,
			deletedIncomplete: 1,
		});
		await expect(stat(oldComplete)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(stat(oldPart)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(recent, "utf8")).toBe("x");
		expect(await readFile(unrelated, "utf8")).toBe("x");
	});
});
