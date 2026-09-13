import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
	CONTEXT_CHECKPOINT_PREFIX,
	DefaultContextManager,
	InMemoryTraceSink,
	MAX_AGENTS_MD_BYTES,
	Session,
} from "../packages/agent-core/dist/index.js";
import {
	AgentServiceRuntime,
	createAgentServiceHttpServer,
	serviceFailure,
} from "../packages/agent-service/dist/index.js";
import { createCalculatorTool } from "../packages/agent-tools/dist/index.js";
import { ChatCompletionsAdapter } from "../packages/chat-completions-adapter/dist/index.js";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is missing.");

const startedAt = Date.now();
const runNonce = `${startedAt}_${process.pid}`;
const model = {
	id: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash",
	name: "DeepSeek Workspace AGENTS.md E2E",
	api: "openai-completions",
	baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
	provider: "deepseek",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 384_000,
};
const adapter = new ChatCompletionsAdapter({ model, apiKey });
const compactionModel = {
	...model,
	id: process.env.DEEPSEEK_COMPACTION_MODEL ?? "deepseek-chat",
	name: "DeepSeek Workspace Compaction E2E",
	reasoning: false,
	maxTokens: 4_096,
};
const compactionAdapter = new ChatCompletionsAdapter({ model: compactionModel, apiKey, timeoutMs: 90_000 });
const artifactDirectory = resolve(process.env.WORKSPACE_E2E_ARTIFACT_DIR ?? "artifacts");
const jsonlPath = join(artifactDirectory, "workspace-agents-md-live-e2e.jsonl");
const summaryPath = join(artifactDirectory, "workspace-agents-md-live-e2e-summary.json");
const root = await mkdtemp(join(tmpdir(), "ailoha-workspace-live-e2e-"));
const requestedCases = new Set(
	(process.env.WORKSPACE_E2E_CASES ?? "LOCAL-01,LIVE-01,LIVE-02,LIVE-03,LIVE-04,LIVE-05")
		.split(",")
		.map((value) => value.trim().toUpperCase())
		.filter(Boolean),
);

let sequence = 0;
const records = [];
const caseResults = [];
let liveProviderCalls = 0;
let failure;

function record(type, data = {}) {
	records.push({
		sequence: ++sequence,
		elapsedMs: Date.now() - startedAt,
		type,
		...data,
	});
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function textOf(message) {
	return message?.content
		?.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("") ?? "";
}

function messageText(message) {
	if (typeof message.content === "string") return message.content;
	return textOf(message);
}

function userMessage(content, timestamp) {
	return { role: "user", content, timestamp };
}

function historicalAssistant(text, timestamp) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function stripJsonFence(text) {
	const trimmed = text.trim();
	if (!trimmed.startsWith("```")) return trimmed;
	return trimmed.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
}

function estimateContext(context) {
	const serialized = JSON.stringify({
		systemPrompt: context.systemPrompt,
		messages: context.messages,
		tools: context.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
	});
	return { inputTokens: Math.ceil(serialized.length / 4), projectionKey: "workspace-live-json-char-v1" };
}

function occurrences(text, marker) {
	return text.split(marker).length - 1;
}

function systemText(payload) {
	const system = payload.messages.find((message) => message.role === "system");
	if (!system) return "";
	return typeof system.content === "string"
		? system.content
		: system.content.map((part) => part.text ?? "").join("");
}

function assertSuccessfulModelResult(call, label) {
	assert(call.response?.status === 200, `${label}: expected HTTP 200.`);
	assert(call.result, `${label}: missing model result.`);
	assert(call.result.usage.input > 0, `${label}: input token usage was not positive.`);
	assert(call.result.usage.output > 0, `${label}: output token usage was not positive.`);
	assert(call.result.usage.totalTokens > 0, `${label}: total token usage was not positive.`);
}

async function createWorkspace(name, content) {
	const cwd = join(root, name);
	await mkdir(cwd);
	if (content !== undefined) await writeFile(join(cwd, "AGENTS.md"), content, "utf8");
	return cwd;
}

async function replaceAgentsEnv(cwd, content) {
	const temporaryPath = join(cwd, `AGENTS.md.${runNonce}.tmp`);
	await writeFile(temporaryPath, content, "utf8");
	await rename(temporaryPath, join(cwd, "AGENTS.md"));
}

function createRecordingRunner(caseId) {
	const calls = [];
	return {
		calls,
		runner: {
			async run(context, { signal }) {
				const call = {
					caseId,
					callIndex: calls.length + 1,
					contextMetadata: context.systemPromptMetadata,
				};
				calls.push(call);
				liveProviderCalls += 1;
				const result = await adapter.complete({
					systemPrompt: context.systemPrompt,
					messages: [...context.messages],
					tools: [...context.tools],
				}, {
					signal,
					onPayload(payload) {
						call.payload = structuredClone(payload);
						record("model.request", {
							caseId,
							callIndex: call.callIndex,
							contextMetadata: call.contextMetadata,
							payload: call.payload,
						});
					},
					onResponse(response) {
						call.response = {
							status: response.status,
							requestId: response.headers["x-request-id"] ?? response.headers["x-ds-request-id"],
							contentType: response.headers["content-type"],
						};
						record("model.response", { caseId, callIndex: call.callIndex, ...call.response });
					},
				});
				call.result = result;
				record("model.result", {
					caseId,
					callIndex: call.callIndex,
					stopReason: result.stopReason,
					usage: result.usage,
					content: result.content,
				});
				return result;
			},
		},
	};
}

async function runCase(caseId, operation) {
	if (!requestedCases.has(caseId)) return;
	const beforeCalls = liveProviderCalls;
	const caseStartedAt = Date.now();
	record("case.started", { caseId });
	try {
		const evidence = await operation();
		const result = {
			caseId,
			status: "passed",
			durationMs: Date.now() - caseStartedAt,
			providerCalls: liveProviderCalls - beforeCalls,
			...evidence,
		};
		caseResults.push(result);
		record("case.finished", result);
		console.log(`PASS ${caseId} (${result.providerCalls} provider calls, ${result.durationMs} ms)`);
	} catch (error) {
		const result = {
			caseId,
			status: "failed",
			durationMs: Date.now() - caseStartedAt,
			providerCalls: liveProviderCalls - beforeCalls,
			error: error instanceof Error ? { name: error.name, message: error.message, code: error.code } : String(error),
		};
		caseResults.push(result);
		record("case.finished", result);
		throw error;
	}
}

async function localFailureCase() {
	const scenarios = [
		{
			name: "too-large",
			code: "WORKSPACE_INSTRUCTIONS_TOO_LARGE",
			bytes: Buffer.from("x".repeat(MAX_AGENTS_MD_BYTES + 1)),
		},
		{
			name: "invalid-utf8",
			code: "WORKSPACE_INSTRUCTIONS_INVALID_UTF8",
			bytes: Buffer.from([0xc3, 0x28]),
		},
	];
	for (const scenario of scenarios) {
		const cwd = await createWorkspace(`local-${scenario.name}`);
		await writeFile(join(cwd, "AGENTS.md"), scenario.bytes);
		let providerCalls = 0;
		let contextManager;
		const session = await Session.create({
			model,
			workspace: { cwd },
			createModelRunner: () => ({
				async run() {
					providerCalls += 1;
					throw new Error("Provider must not be called.");
				},
			}),
			createContextManager(context) {
				contextManager = new DefaultContextManager({ workspace: context.workspace });
				return contextManager;
			},
		});
		try {
			let caught;
			try {
				await session.agent.prompt("LOCAL_FAILURE_PROBE");
			} catch (error) {
				caught = error;
			}
			assert(caught?.code === scenario.code, `${scenario.name}: expected ${scenario.code}, got ${caught?.code}.`);
			assert(providerCalls === 0, `${scenario.name}: provider was called.`);
			assert(session.agent.state.status === "idle", `${scenario.name}: agent did not return to idle.`);
			assert(contextManager.snapshot().messages.length === 0, `${scenario.name}: failed prompt was committed.`);
			record("local.failure.checked", { caseId: "LOCAL-01", scenario: scenario.name, code: caught.code });
		} finally {
			await session.dispose();
		}
	}
	return { scenarios: scenarios.length };
}

async function basicInjectionCase() {
	const marker = `AGENTS_MD_BASIC_${runNonce}`;
	const basePrompt = "You are running a live workspace-instruction E2E test. Follow exact marker instructions. Do not call tools and do not add unrelated text.";
	const cwd = await createWorkspace("live-basic", [
		`When the user sends WORKSPACE_INSTRUCTION_PROBE, reply with exactly this marker: ${marker}`,
		"Do not mention any other AGENTS_MD_ marker.",
	].join("\n"));
	const recording = createRecordingRunner("LIVE-01");
	const session = await Session.create({
		model,
		workspace: { cwd },
		createModelRunner: () => recording.runner,
		contextManagerOptions: { systemPrompts: [basePrompt] },
	});
	try {
		const result = await session.agent.prompt("WORKSPACE_INSTRUCTION_PROBE");
		assert(recording.calls.length === 1, "LIVE-01: expected exactly one provider call.");
		const call = recording.calls[0];
		assertSuccessfulModelResult(call, "LIVE-01");
		const system = systemText(call.payload);
		assert(system.indexOf(basePrompt) < system.indexOf("Workspace-specific instructions"), "LIVE-01: prompt order is wrong.");
		assert(occurrences(system, marker) === 1, "LIVE-01: marker should occur once in system content.");
		assert(call.payload.messages.slice(1).every((message) => !JSON.stringify(message).includes(marker)), "LIVE-01: marker leaked outside system message.");
		assert(!system.includes(cwd), "LIVE-01: cwd leaked into provider system content.");
		const answer = textOf(result.finalAssistantMessage);
		assert(occurrences(answer, marker) === 1, `LIVE-01: unexpected answer: ${answer}`);
		return { marker, answer, workspaceCwd: session.workspace.cwd };
	} finally {
		await session.dispose();
	}
}

async function hotReloadCase() {
	const markerV1 = `AGENTS_MD_RELOAD_V1_${runNonce}`;
	const markerV2 = `AGENTS_MD_RELOAD_V2_${runNonce}`;
	const cwd = await createWorkspace("live-reload", `When the user sends RELOAD_PROBE_ONE, reply with exactly ${markerV1}.`);
	const recording = createRecordingRunner("LIVE-02");
	const session = await Session.create({
		model,
		workspace: { cwd },
		createModelRunner: () => recording.runner,
		contextManagerOptions: {
			systemPrompts: ["Follow the current workspace marker instruction exactly. Do not add other text."],
		},
	});
	const workspaceIdentity = session.workspace;
	try {
		const first = await session.agent.prompt("RELOAD_PROBE_ONE");
		await replaceAgentsEnv(cwd, [
			`When the user sends RELOAD_PROBE_TWO, reply with exactly ${markerV2}.`,
			`The active marker is ${markerV2}; do not repeat older markers from conversation history.`,
		].join("\n"));
		const second = await session.agent.prompt("RELOAD_PROBE_TWO");
		assert(recording.calls.length === 2, "LIVE-02: expected two provider calls.");
		const firstSystem = systemText(recording.calls[0].payload);
		const secondSystem = systemText(recording.calls[1].payload);
		assert(firstSystem.includes(markerV1) && !firstSystem.includes(markerV2), "LIVE-02: first system marker mismatch.");
		assert(secondSystem.includes(markerV2) && !secondSystem.includes(markerV1), "LIVE-02: second system retained stale marker.");
		assert(textOf(first.finalAssistantMessage).includes(markerV1), "LIVE-02: first behavior did not follow v1.");
		const secondAnswer = textOf(second.finalAssistantMessage);
		assert(secondAnswer.includes(markerV2) && !secondAnswer.includes(markerV1), `LIVE-02: unexpected second answer: ${secondAnswer}`);
		assert(session.workspace === workspaceIdentity, "LIVE-02: workspace identity changed across Runs.");
		for (const call of recording.calls) assertSuccessfulModelResult(call, "LIVE-02");
		return { markerV1, markerV2, secondAnswer };
	} finally {
		await session.dispose();
	}
}

async function toolLoopCase() {
	const marker = `AGENTS_MD_TOOL_${runNonce}`;
	const cwd = await createWorkspace("live-tool", `After calculator succeeds, include marker ${marker} in the final answer.`);
	const recording = createRecordingRunner("LIVE-03");
	const trace = new InMemoryTraceSink();
	const session = await Session.create({
		model,
		workspace: { cwd },
		createModelRunner: () => recording.runner,
		contextManagerOptions: {
			systemPrompts: ["For arithmetic requests, call calculator exactly once, wait for its result, then answer briefly."],
		},
		configureTools: (manager) => manager.register("calculator", () => createCalculatorTool()),
		toolRequests: [{ name: "calculator" }],
		trace: { sink: trace, sinkOwnership: "external", capture: { arguments: "full", results: "full" } },
	});
	try {
		const result = await session.agent.prompt("请调用 calculator 计算 (137 * 42) + 19，然后给出结果。", {
			runId: `workspace_tool_${runNonce}`,
		});
		assert(recording.calls.length === 2, `LIVE-03: expected two provider calls, got ${recording.calls.length}.`);
		assert(systemText(recording.calls[0].payload) === systemText(recording.calls[1].payload), "LIVE-03: system prompt changed inside tool loop.");
		for (const call of recording.calls) assertSuccessfulModelResult(call, "LIVE-03");
		const events = trace.snapshot();
		const toolRequested = events.filter((event) => event.type === "tool.call.requested");
		const toolFinished = events.filter((event) => event.type === "tool.call.finished");
		assert(toolRequested.length === 1 && toolRequested[0].toolName === "calculator", "LIVE-03: calculator was not requested exactly once.");
		assert(toolFinished.length === 1 && toolFinished[0].outcome === "success", "LIVE-03: calculator did not finish successfully.");
		const contextPrepared = events.find((event) => event.type === "context.prepared");
		assert(contextPrepared?.workspaceInstructionsLoaded === true, "LIVE-03: trace did not record workspace instructions.");
		assert(recording.calls[0].contextMetadata.workspaceInstructionsSha256 === recording.calls[1].contextMetadata.workspaceInstructionsSha256, "LIVE-03: workspace hash changed inside Run.");
		const answer = textOf(result.finalAssistantMessage);
		assert(answer.includes("5773") && answer.includes(marker), `LIVE-03: unexpected final answer: ${answer}`);
		return { marker, answer, traceTypes: events.map((event) => event.type) };
	} finally {
		await session.dispose();
	}
}

async function isolationCase() {
	const markerA = `AGENTS_MD_ISOLATION_A_${runNonce}`;
	const markerB = `AGENTS_MD_ISOLATION_B_${runNonce}`;
	const [cwdA, cwdB] = await Promise.all([
		createWorkspace("live-isolation-a", `For ISOLATION_PROBE, reply with exactly ${markerA}.`),
		createWorkspace("live-isolation-b", `For ISOLATION_PROBE, reply with exactly ${markerB}.`),
	]);
	const recordingA = createRecordingRunner("LIVE-04-A");
	const recordingB = createRecordingRunner("LIVE-04-B");
	const [sessionA, sessionB] = await Promise.all([
		Session.create({ model, workspace: { cwd: cwdA }, createModelRunner: () => recordingA.runner }),
		Session.create({ model, workspace: { cwd: cwdB }, createModelRunner: () => recordingB.runner }),
	]);
	try {
		const [resultA, resultB] = await Promise.all([
			sessionA.agent.prompt("ISOLATION_PROBE"),
			sessionB.agent.prompt("ISOLATION_PROBE"),
		]);
		const systemA = systemText(recordingA.calls[0].payload);
		const systemB = systemText(recordingB.calls[0].payload);
		const answerA = textOf(resultA.finalAssistantMessage);
		const answerB = textOf(resultB.finalAssistantMessage);
		assert(sessionA.workspace.cwd !== sessionB.workspace.cwd, "LIVE-04: workspace cwd values are equal.");
		assert(systemA.includes(markerA) && !systemA.includes(markerB), "LIVE-04: Session A system prompt crossed workspaces.");
		assert(systemB.includes(markerB) && !systemB.includes(markerA), "LIVE-04: Session B system prompt crossed workspaces.");
		assert(answerA.includes(markerA) && !answerA.includes(markerB), `LIVE-04: unexpected A answer: ${answerA}`);
		assert(answerB.includes(markerB) && !answerB.includes(markerA), `LIVE-04: unexpected B answer: ${answerB}`);
		assertSuccessfulModelResult(recordingA.calls[0], "LIVE-04-A");
		assertSuccessfulModelResult(recordingB.calls[0], "LIVE-04-B");
		return { markerA, markerB, answerA, answerB };
	} finally {
		await Promise.all([sessionA.dispose(), sessionB.dispose()]);
	}
}

async function waitForTerminalRun(baseUrl, runId, headers, timeoutMs = 120_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const response = await fetch(`${baseUrl}/v1/runs/${runId}`, { headers });
		assert(response.ok, `LIVE-05: GET Run failed with ${response.status}.`);
		const run = await response.json();
		if (run.status !== "running") return run;
		await new Promise((resolveWait) => setTimeout(resolveWait, 200));
	}
	throw new Error(`LIVE-05: Run ${runId} timed out.`);
}

async function httpServiceCase() {
	const marker = `AGENTS_MD_HTTP_${runNonce}`;
	const hostOnlyText = `HOST_ONLY_WORKSPACE_INSTRUCTION_${runNonce}`;
	const cwd = await createWorkspace("live-http", [
		`${hostOnlyText}.`,
		`When the user sends HTTP_WORKSPACE_PROBE, reply with exactly ${marker}.`,
	].join("\n"));
	const traceDirectory = join(root, "live-http-traces");
	const recording = createRecordingRunner("LIVE-05");
	const runtime = new AgentServiceRuntime({
		traceConfig: {
			enabled: true,
			rootDir: traceDirectory,
			level: "execution",
			captureArguments: "redacted",
			captureResults: "redacted",
			maxValueBytes: 4_096,
			fsyncOnRunFinish: false,
			retentionDays: 1,
		},
		resolveSessionOptions(profile, context) {
			if (context.workspaceId !== "workspace-a") {
				throw serviceFailure("workspace_not_allowed", "Unknown workspaceId.", 400);
			}
			return {
				model,
				workspace: { cwd },
				createModelRunner: () => recording.runner,
				contextManagerOptions: { systemPrompts: profile.systemPrompts, maxTurns: profile.maxTurns },
			};
		},
	});
	const server = createAgentServiceHttpServer(runtime, { authenticate: () => ({ ownerId: "workspace-live-owner" }) });
	let baseUrl;
	try {
		await new Promise((resolveListen, rejectListen) => {
			server.once("error", rejectListen);
			server.listen(0, "127.0.0.1", resolveListen);
		});
		const address = server.address();
		assert(address && typeof address !== "string", "LIVE-05: server address unavailable.");
		baseUrl = `http://127.0.0.1:${address.port}`;
		const baseHeaders = { "content-type": "application/json", "x-owner-id": "workspace-live-owner" };
		let response = await fetch(`${baseUrl}/v1/agent-profiles`, {
			method: "POST",
			headers: baseHeaders,
			body: JSON.stringify({
				id: "workspace-live-profile",
				name: "Workspace live profile",
				modelId: model.id,
				systemPrompts: ["Follow the workspace probe instruction exactly and do not add unrelated text."],
			}),
		});
		assert(response.status === 201, `LIVE-05: profile creation returned ${response.status}.`);

		response = await fetch(`${baseUrl}/v1/sessions`, {
			method: "POST",
			headers: { ...baseHeaders, "idempotency-key": "raw-cwd" },
			body: JSON.stringify({ agentProfileId: "workspace-live-profile", cwd }),
		});
		assert(response.status === 400, `LIVE-05: raw cwd was not rejected (${response.status}).`);
		assert(recording.calls.length === 0, "LIVE-05: raw cwd rejection called Provider.");

		response = await fetch(`${baseUrl}/v1/sessions`, {
			method: "POST",
			headers: { ...baseHeaders, "idempotency-key": "unknown-workspace" },
			body: JSON.stringify({ agentProfileId: "workspace-live-profile", workspaceId: "unknown" }),
		});
		assert(response.status === 400, `LIVE-05: unknown workspace returned ${response.status}.`);
		assert(recording.calls.length === 0, "LIVE-05: unknown workspace called Provider.");

		response = await fetch(`${baseUrl}/v1/sessions`, {
			method: "POST",
			headers: { ...baseHeaders, "idempotency-key": "valid-workspace" },
			body: JSON.stringify({ agentProfileId: "workspace-live-profile", workspaceId: "workspace-a" }),
		});
		assert(response.status === 201, `LIVE-05: Session creation returned ${response.status}.`);
		const session = await response.json();
		assert(session.workspaceId === "workspace-a" && session.workspace?.cwd === resolve(cwd), "LIVE-05: resolved workspace mismatch.");

		response = await fetch(`${baseUrl}/v1/sessions/${session.id}/messages`, {
			method: "POST",
			headers: { ...baseHeaders, "idempotency-key": "workspace-probe" },
			body: JSON.stringify({ content: "HTTP_WORKSPACE_PROBE", delivery: "prompt" }),
		});
		assert(response.status === 202, `LIVE-05: message admission returned ${response.status}.`);
		const accepted = await response.json();
		const run = await waitForTerminalRun(baseUrl, accepted.runId, baseHeaders);
		assert(run.status === "succeeded", `LIVE-05: Run failed: ${JSON.stringify(run)}`);

		response = await fetch(`${baseUrl}/v1/sessions/${session.id}/messages`, { headers: baseHeaders });
		assert(response.ok, `LIVE-05: transcript returned ${response.status}.`);
		const transcript = await response.json();
		const answer = transcript.items
			.filter((message) => message.role === "assistant")
			.flatMap((message) => message.content)
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		assert(answer.includes(marker), `LIVE-05: answer did not follow workspace instruction: ${answer}`);
		assert(!JSON.stringify(transcript).includes(hostOnlyText), "LIVE-05: full AGENTS.md body leaked into transcript.");

		response = await fetch(`${baseUrl}/v1/runs/${accepted.runId}/trace`, { headers: baseHeaders });
		assert(response.status === 200, `LIVE-05: persisted trace returned ${response.status}.`);
		const traceEvents = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
		const contextPrepared = traceEvents.find((event) => event.type === "context.prepared");
		assert(contextPrepared?.workspaceInstructionsLoaded === true, "LIVE-05: trace omitted workspace load evidence.");
		assertSuccessfulModelResult(recording.calls[0], "LIVE-05");
		return { marker, sessionId: session.id, runId: accepted.runId, answer, traceEvents: traceEvents.length };
	} finally {
		await new Promise((resolveClose) => {
			if (!server.listening) return resolveClose();
			server.close(() => resolveClose());
			server.closeAllConnections();
		});
		await runtime.dispose();
	}
}

async function manualCompactionCase() {
	const markerV1 = `AGENTS_MD_COMPACT_V1_${runNonce}`;
	const markerV2 = `AGENTS_MD_COMPACT_V2_${runNonce}`;
	const cwd = await createWorkspace("live-compaction", `For COMPACTION_PROBE_ONE, reply with exactly ${markerV1}.`);
	const business = createRecordingRunner("LIVE-06-BUSINESS");
	const summaryCalls = [];
	let contextManager;
	const summaryRunner = {
		async run(input) {
			const call = { caseId: "LIVE-06-SUMMARY", callIndex: summaryCalls.length + 1, inputSystemPrompt: input.systemPrompt };
			summaryCalls.push(call);
			liveProviderCalls += 1;
			const result = await compactionAdapter.complete({
				systemPrompt: input.systemPrompt,
				messages: [userMessage(input.data, Date.now())],
				tools: [],
			}, {
				signal: input.signal,
				maxTokens: input.maxOutputTokens,
				temperature: 0,
				toolChoice: "none",
				onPayload(payload) {
					call.payload = structuredClone(payload);
					record("model.request", { caseId: call.caseId, callIndex: call.callIndex, payload: call.payload });
					return { ...payload, response_format: { type: "json_object" } };
				},
				onResponse(response) {
					call.response = {
						status: response.status,
						requestId: response.headers["x-request-id"] ?? response.headers["x-ds-request-id"],
						contentType: response.headers["content-type"],
					};
					record("model.response", { caseId: call.caseId, callIndex: call.callIndex, ...call.response });
				},
			});
			call.result = result;
			record("model.result", {
				caseId: call.caseId,
				callIndex: call.callIndex,
				stopReason: result.stopReason,
				usage: result.usage,
				content: result.content,
			});
			return {
				text: stripJsonFence(messageText(result)),
				stopReason: result.stopReason === "length" ? "length" : "stop",
				usage: {
					inputTokens: result.usage.input,
					outputTokens: result.usage.output,
					cacheReadTokens: result.usage.cacheRead,
					cacheWriteTokens: result.usage.cacheWrite,
					reasoningTokens: result.usage.reasoning,
					totalTokens: result.usage.totalTokens,
				},
			};
		},
	};
	const compaction = {
		model,
		requestOutputTokens: 1_000,
		autoCompactTokenLimit: 20_000,
		targetInputTokens: 10_000,
		safetyMarginTokens: 2_000,
		headroomTokens: 2_000,
		keepRecentSteps: 0,
		summaryMaxOutputTokens: 2_000,
		tokenEstimator: { estimate: ({ context }) => estimateContext(context) },
		summaryRunner,
	};
	const initialMessages = [
		userMessage(`Historical workspace task COMPACT-42. ${"old context ".repeat(180)}`, 10),
		historicalAssistant(`Recorded COMPACT-42. ${"old result ".repeat(120)}`, 20),
	];
	const session = await Session.create({
		model,
		workspace: { cwd },
		createModelRunner: () => business.runner,
		createContextManager(context) {
			contextManager = new DefaultContextManager({
				workspace: context.workspace,
				systemPrompts: ["Follow the current workspace marker instruction exactly. During compaction, obey the checkpoint schema."],
				messages: initialMessages,
				compaction,
			});
			return contextManager;
		},
	});
	try {
		const first = await session.agent.prompt("COMPACTION_PROBE_ONE");
		assert(textOf(first.finalAssistantMessage).includes(markerV1), "LIVE-06: initial Run did not follow v1.");
		await replaceAgentsEnv(cwd, [
			`For COMPACTION_PROBE_TWO, reply with exactly ${markerV2}.`,
			`The active marker is ${markerV2}; never repeat older workspace markers.`,
		].join("\n"));
		const compactResult = await session.agent.compact();
		assert(compactResult.changed === true, `LIVE-06: manual compact did not change context: ${JSON.stringify(compactResult)}`);
		assert(summaryCalls.length === 1, `LIVE-06: expected one summary call, got ${summaryCalls.length}.`);
		const summarySystem = systemText(summaryCalls[0].payload);
		assert(summarySystem.includes(markerV2) && !summarySystem.includes(markerV1), "LIVE-06: summary system prompt did not reload v2.");
		assert(summaryCalls[0].payload.tools === undefined, "LIVE-06: summary payload unexpectedly included tools.");
		assert(summaryCalls[0].payload.tool_choice === "none", "LIVE-06: summary payload did not disable tools.");
		assertSuccessfulModelResult(summaryCalls[0], "LIVE-06-SUMMARY");
		assert(contextManager.snapshot().messages.some((message) => (
			message.role === "user" && typeof message.content === "string" && message.content.startsWith(CONTEXT_CHECKPOINT_PREFIX)
		)), "LIVE-06: compacted context has no checkpoint.");

		const second = await session.agent.prompt("COMPACTION_PROBE_TWO");
		const secondAnswer = textOf(second.finalAssistantMessage);
		assert(secondAnswer.includes(markerV2) && !secondAnswer.includes(markerV1), `LIVE-06: unexpected post-compact answer: ${secondAnswer}`);
		assert(business.calls.length === 2, `LIVE-06: expected two business calls, got ${business.calls.length}.`);
		const postCompactSystem = systemText(business.calls[1].payload);
		assert(postCompactSystem.includes(markerV2) && !postCompactSystem.includes(markerV1), "LIVE-06: post-compact Run did not load v2.");
		for (const call of business.calls) assertSuccessfulModelResult(call, "LIVE-06-BUSINESS");
		return {
			markerV1,
			markerV2,
			secondAnswer,
			beforeTokens: compactResult.beforeTokens,
			afterTokens: compactResult.afterTokens,
			summaryCalls: summaryCalls.length,
		};
	} finally {
		await session.dispose();
	}
}

try {
	record("suite.started", { modelId: model.id, requestedCases: [...requestedCases] });
	await runCase("LOCAL-01", localFailureCase);
	await runCase("LIVE-01", basicInjectionCase);
	await runCase("LIVE-02", hotReloadCase);
	await runCase("LIVE-03", toolLoopCase);
	await runCase("LIVE-04", isolationCase);
	await runCase("LIVE-05", httpServiceCase);
	await runCase("LIVE-06", manualCompactionCase);
} catch (error) {
	failure = error;
	record("suite.failed", {
		error: error instanceof Error ? { name: error.name, message: error.message, code: error.code } : String(error),
	});
} finally {
	const resolvedTmp = resolve(tmpdir());
	if (dirname(root) !== resolvedTmp || !basename(root).startsWith("ailoha-workspace-live-e2e-")) {
		failure ??= new Error(`Refusing to remove unexpected temporary root: ${root}`);
	} else {
		await rm(root, { recursive: true, force: true });
	}
	const summary = {
		status: failure ? "failed" : "passed",
		startedAt,
		durationMs: Date.now() - startedAt,
		modelId: model.id,
		baseUrl: model.baseUrl,
		requestedCases: [...requestedCases],
		providerCalls: liveProviderCalls,
		cases: caseResults,
		artifacts: { jsonlPath, summaryPath },
		...(failure ? { error: failure instanceof Error ? { name: failure.name, message: failure.message, code: failure.code } : String(failure) } : {}),
	};
	record("suite.finished", summary);
	await mkdir(artifactDirectory, { recursive: true });
	const jsonl = `${records.map((item) => JSON.stringify(item)).join("\n")}\n`;
	const summaryJson = `${JSON.stringify(summary, null, 2)}\n`;
	if (jsonl.includes(apiKey) || summaryJson.includes(apiKey)) {
		failure ??= new Error("Artifact safety check failed: API key appeared in output.");
	} else {
		await Promise.all([
			writeFile(jsonlPath, jsonl, "utf8"),
			writeFile(summaryPath, summaryJson, "utf8"),
		]);
	}
}

if (failure) throw failure;
console.log(JSON.stringify({
	status: "passed",
	modelId: model.id,
	providerCalls: liveProviderCalls,
	cases: caseResults.map((item) => item.caseId),
	jsonlPath,
	summaryPath,
}, null, 2));
