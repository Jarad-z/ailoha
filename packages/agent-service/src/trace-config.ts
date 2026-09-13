import { lstat, readdir, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
	PartitionedJsonlTraceSink,
	TraceEventHub,
} from "@ailoha/agent-core";
import type { CaptureMode, TraceCapturePolicy } from "@ailoha/agent-core";
import type { AgentServiceTraceConfig, AgentServiceTraceLevel } from "./types.js";

const CAPTURE_MODES = new Set<CaptureMode>(["none", "metadata", "redacted", "full"]);

function booleanValue(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined || value === "") return fallback;
	if (value === "1" || value.toLowerCase() === "true") return true;
	if (value === "0" || value.toLowerCase() === "false") return false;
	throw new TypeError(`Invalid boolean Trace setting: ${value}`);
}

function integerValue(name: string, value: string | undefined, fallback: number): number {
	if (value === undefined || value === "") return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) throw new TypeError(`${name} must be a non-negative integer.`);
	return parsed;
}

function captureMode(name: string, value: string | undefined, fallback: CaptureMode): CaptureMode {
	const parsed = (value ?? fallback) as CaptureMode;
	if (!CAPTURE_MODES.has(parsed)) throw new TypeError(`${name} is not a valid capture mode.`);
	return parsed;
}

export function loadAgentServiceTraceConfig(
	env: Readonly<Record<string, string | undefined>> = process.env,
	baseDir = process.cwd(),
): AgentServiceTraceConfig {
	const level = (env.TRACE_LEVEL ?? "execution") as AgentServiceTraceLevel;
	if (!(["summary", "execution", "debug"] as const).includes(level)) throw new TypeError("TRACE_LEVEL is invalid.");
	const configuredDir = env.TRACE_DIR ?? "./data/traces";
	return Object.freeze({
		enabled: booleanValue(env.TRACE_ENABLED, true),
		rootDir: isAbsolute(configuredDir) ? resolve(configuredDir) : resolve(baseDir, configuredDir),
		level,
		captureArguments: captureMode("TRACE_CAPTURE_ARGUMENTS", env.TRACE_CAPTURE_ARGUMENTS, "redacted"),
		captureResults: captureMode("TRACE_CAPTURE_RESULTS", env.TRACE_CAPTURE_RESULTS, "redacted"),
		maxValueBytes: integerValue("TRACE_MAX_VALUE_BYTES", env.TRACE_MAX_VALUE_BYTES, 4_096),
		fsyncOnRunFinish: booleanValue(env.TRACE_FSYNC_ON_RUN_FINISH, false),
		retentionDays: integerValue("TRACE_RETENTION_DAYS", env.TRACE_RETENTION_DAYS, 30),
		...(env.TRACE_MAX_PENDING_EVENTS === undefined ? {} : {
			maxPendingEvents: integerValue("TRACE_MAX_PENDING_EVENTS", env.TRACE_MAX_PENDING_EVENTS, 1_000),
		}),
	});
}

export function createAgentServiceTrace(config: AgentServiceTraceConfig): {
	readonly traceHub: TraceEventHub;
	readonly traceStore?: PartitionedJsonlTraceSink;
	readonly capture: TraceCapturePolicy;
	readonly level: AgentServiceTraceLevel;
} {
	const capture: TraceCapturePolicy = Object.freeze({
		arguments: config.captureArguments,
		results: config.captureResults,
		messages: "metadata",
		requests: config.level === "debug" ? "redacted" : "none",
		responses: config.level === "debug" ? "redacted" : "none",
		decisionSummaries: "redacted",
		maxValueBytes: config.maxValueBytes,
	});
	if (!config.enabled) return { traceHub: new TraceEventHub(), capture, level: config.level };
	const traceStore = new PartitionedJsonlTraceSink({
		rootDir: config.rootDir,
		fsyncOnRunFinish: config.fsyncOnRunFinish,
		...(config.maxPendingEvents === undefined ? {} : { maxPendingEvents: config.maxPendingEvents }),
	});
	void cleanupAgentServiceTraces(config).catch(() => {
		// Retention failures are observational and must not prevent service startup.
	});
	return {
		traceHub: new TraceEventHub({ sinks: [traceStore] }),
		traceStore,
		capture,
		level: config.level,
	};
}

export async function cleanupAgentServiceTraces(
	config: Pick<AgentServiceTraceConfig, "rootDir" | "retentionDays">,
	nowUnixMs = Date.now(),
): Promise<{ readonly deletedCompleted: number; readonly deletedIncomplete: number }> {
	const root = resolve(config.rootDir);
	const completeCutoff = nowUnixMs - config.retentionDays * 24 * 60 * 60 * 1_000;
	const incompleteCutoff = nowUnixMs - 7 * 24 * 60 * 60 * 1_000;
	let deletedCompleted = 0;
	let deletedIncomplete = 0;

	async function visit(directory: string): Promise<void> {
		let entries: import("node:fs").Dirent<string>[];
		try { entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" }); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			const path = resolve(directory, entry.name);
			const relation = relative(root, path);
			if (relation.startsWith("..") || isAbsolute(relation)) continue;
			const metadata = await lstat(path);
			if (metadata.isSymbolicLink()) continue;
			if (metadata.isDirectory()) {
				await visit(path);
				continue;
			}
			if (!metadata.isFile()) continue;
			if (entry.name.endsWith(".jsonl") && metadata.mtimeMs < completeCutoff) {
				await unlink(path);
				deletedCompleted++;
			} else if (entry.name.endsWith(".jsonl.part") && metadata.mtimeMs < incompleteCutoff) {
				await unlink(path);
				deletedIncomplete++;
			}
		}
	}

	await visit(root);
	return Object.freeze({ deletedCompleted, deletedIncomplete });
}
