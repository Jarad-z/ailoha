import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is missing.");

const serverPath = fileURLToPath(new URL("./deepseek-http-server.mjs", import.meta.url));
const traceDir = await mkdtemp(join(tmpdir(), "ailoha-live-traces-"));
const child = spawn(process.execPath, [serverPath], {
	cwd: process.cwd(),
	env: {
		...process.env,
		PORT: "0",
		TRACE_ENABLED: "1",
		TRACE_DIR: traceDir,
		TRACE_LEVEL: "execution",
		LIVE_E2E_FIXTURE_TOOLS: "1",
	},
	stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
	stderr += chunk;
});

const ready = new Promise((resolve, reject) => {
	const timeout = setTimeout(() => reject(new Error("Timed out waiting for the live HTTP server.")), 20_000);
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
		const match = /^READY (http:\/\/127\.0\.0\.1:\d+) model=(\S+)$/m.exec(stdout);
		if (match) {
			clearTimeout(timeout);
			resolve({ baseUrl: match[1], modelId: match[2] });
		}
	});
	child.once("exit", (code) => {
		clearTimeout(timeout);
		reject(new Error(`Live HTTP server exited before readiness (code ${code}): ${stderr.trim()}`));
	});
});

function headers(idempotencyKey) {
	return {
		"content-type": "application/json",
		"x-owner-id": "live-e2e-owner",
		...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
	};
}

async function request(baseUrl, path, init = {}) {
	const response = await fetch(`${baseUrl}${path}`, {
		...init,
		headers: { ...headers(), ...init.headers },
	});
	if (!response.ok) {
		throw new Error(`${init.method ?? "GET"} ${path} failed (${response.status}): ${await response.text()}`);
	}
	return response;
}

async function waitForTerminalRun(baseUrl, runId, timeoutMs = 90_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const response = await request(baseUrl, `/v1/runs/${runId}`);
		const run = await response.json();
		if (run.status !== "running") return run;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`Run ${runId} did not finish within ${timeoutMs}ms.`);
}

async function collectTrace(response, timeoutMs = 90_000) {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Trace response has no body.");
	const decoder = new TextDecoder();
	const events = [];
	let buffer = "";
	let timeoutId;
	const timeout = new Promise((_, reject) => {
		timeoutId = setTimeout(() => reject(new Error("Timed out waiting for agent.run.finished trace.")), timeoutMs);
	});
	const consume = (async () => {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) throw new Error("Trace stream closed before agent.run.finished.");
			buffer += decoder.decode(chunk.value, { stream: true });
			let boundary;
			while ((boundary = buffer.indexOf("\n\n")) >= 0) {
				const frame = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
				if (!dataLine) continue;
				const event = JSON.parse(dataLine.slice(6));
				events.push(event);
				if (event.type === "agent.run.finished") return events;
			}
		}
	})();
	try {
		return await Promise.race([consume, timeout]);
	} finally {
		clearTimeout(timeoutId);
	}
}

function transcriptText(transcript) {
	return transcript.items
		.filter((message) => message.role === "assistant")
		.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

let traceController;
try {
	const { baseUrl, modelId } = await ready;
	let response = await request(baseUrl, "/v1/agent-profiles", {
		method: "POST",
		body: JSON.stringify({
			id: "deepseek-live-e2e",
			name: "DeepSeek Live HTTP E2E",
			modelId,
			systemPrompts: [
				"You are running a strict end-to-end test. Select tools only from their names, descriptions, and parameter schemas. For every arithmetic request, you MUST call the calculator tool exactly once, wait for its result, and answer with that result. Never calculate mentally.",
			],
			tools: [{ name: "calculator" }, { name: "search" }, { name: "weather" }],
			maxTurns: 4,
		}),
	});
	if (response.status !== 201) throw new Error(`Expected profile status 201, received ${response.status}.`);

	response = await request(baseUrl, "/v1/sessions", {
		method: "POST",
		headers: headers("create-live-session"),
		body: JSON.stringify({ agentProfileId: "deepseek-live-e2e", title: "Live calculator E2E" }),
	});
	const session = await response.json();

	traceController = new AbortController();
	const traceResponse = await fetch(`${baseUrl}/v1/sessions/${session.id}/trace`, {
		headers: headers(),
		signal: traceController.signal,
	});
	if (!traceResponse.ok) throw new Error(`Trace subscription failed (${traceResponse.status}).`);
	const tracePromise = collectTrace(traceResponse);

	response = await request(baseUrl, `/v1/sessions/${session.id}/messages`, {
		method: "POST",
		headers: headers("live-calculator-message"),
		body: JSON.stringify({
			content: "请务必调用 calculator 工具精确计算 12345 * 6789，只调用一次，然后告诉我结果。",
			delivery: "prompt",
		}),
	});
	if (response.status !== 202) throw new Error(`Expected message status 202, received ${response.status}.`);
	const accepted = await response.json();

	const [run, traceEvents] = await Promise.all([
		waitForTerminalRun(baseUrl, accepted.runId),
		tracePromise,
	]);
	if (run.status !== "succeeded") throw new Error(`Live run failed: ${JSON.stringify(run.error ?? run)}`);

	response = await request(baseUrl, `/v1/sessions/${session.id}/messages`);
	const transcript = await response.json();
	const answer = transcriptText(transcript);
	if (!answer.replaceAll(",", "").replaceAll(" ", "").includes("83810205")) {
		throw new Error(`Final answer does not contain 83810205: ${answer}`);
	}

	const requested = traceEvents.filter((event) => event.type === "tool.call.requested");
	const finished = traceEvents.filter((event) => event.type === "tool.call.finished");
	const traceTypes = traceEvents.map((event) => event.type);
	const expectedTraceTypes = [
		"agent.run.started",
		"context.prepared",
		"llm.call.started",
		"llm.call.finished",
		"tool.call.requested",
		"tool.call.started",
		"tool.call.finished",
		"llm.call.started",
		"llm.call.finished",
		"agent.run.finished",
	];
	if (JSON.stringify(traceTypes) !== JSON.stringify(expectedTraceTypes)) {
		throw new Error(`Live Trace lifecycle is incomplete or out of order: ${JSON.stringify(traceTypes)}`);
	}
	if (requested.length !== 1 || requested[0].toolName !== "calculator") {
		throw new Error(`Expected exactly one calculator request, received: ${JSON.stringify(requested)}`);
	}
	if (finished.length !== 1 || finished[0].toolName !== "calculator" || finished[0].outcome !== "success") {
		throw new Error(`Calculator did not finish successfully: ${JSON.stringify(finished)}`);
	}
	const llmFinished = traceEvents.filter((event) => event.type === "llm.call.finished");
	if (
		llmFinished.length !== 2 ||
		llmFinished[0].decisionType !== "tool_calls" ||
		llmFinished[1].decisionType !== "final" ||
		llmFinished.some((event) => event.outcome !== "success")
	) {
		throw new Error(`Expected one tool-use and one final LLM call: ${JSON.stringify(llmFinished)}`);
	}
	if (!traceEvents.every((event) => event.sessionId === session.id && event.runId === accepted.runId)) {
		throw new Error("Live Trace IDs are inconsistent with the HTTP Session/Run.");
	}
	if (traceEvents.at(-1)?.outcome !== "success") throw new Error("Live Trace did not finish with success.");

	response = await request(baseUrl, `/v1/runs/${accepted.runId}/trace`);
	const persistedText = await response.text();
	const persistedEvents = persistedText.trim().split("\n").map((line) => JSON.parse(line));
	const identity = (event) => [event.eventId, event.sequence, event.type];
	if (JSON.stringify(persistedEvents.map(identity)) !== JSON.stringify(traceEvents.map(identity))) {
		throw new Error("SSE and persisted JSONL Trace facts differ.");
	}
	if (persistedText.includes(process.env.DEEPSEEK_API_KEY)) {
		throw new Error("Persisted Trace contains the API key.");
	}

	const summary = {
		status: "passed",
		modelId,
		sessionId: session.id,
		runId: accepted.runId,
		availableTools: ["calculator", "search", "weather"],
		toolCalls: requested.map((event) => event.toolName),
		answer,
		traceEvents: traceEvents.length,
	};
	const artifactDir = process.env.E2E_ARTIFACT_DIR;
	if (artifactDir) {
		await mkdir(artifactDir, { recursive: true });
		await Promise.all([
			writeFile(join(artifactDir, "live-http-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8"),
			writeFile(join(artifactDir, "live-http-trace.jsonl"), `${persistedText.trim()}\n`, "utf8"),
			writeFile(join(artifactDir, "live-http-transcript.json"), `${JSON.stringify(transcript, null, 2)}\n`, "utf8"),
		]);
	}

	console.log("live HTTP E2E passed:", JSON.stringify(summary));
} finally {
	traceController?.abort();
	if (child.exitCode === null) {
		child.kill("SIGTERM");
		await new Promise((resolve) => {
			const forceClose = setTimeout(() => {
				if (child.exitCode === null) child.kill("SIGKILL");
			}, 5_000);
			child.once("exit", () => {
				clearTimeout(forceClose);
				resolve();
			});
		});
	}
	await rm(traceDir, { recursive: true, force: true });
}
