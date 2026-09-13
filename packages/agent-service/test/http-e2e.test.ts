import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentServiceRuntime, createAgentServiceHttpServer } from "../src/index.js";
import type { AgentModel, ModelRunner } from "@ailoha/agent-core";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const MODEL: AgentModel = {
	id: "http-model",
	name: "HTTP Model",
	api: "test-api",
	provider: "test-provider",
	baseUrl: "https://invalid.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_000,
};

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

const servers: import("node:http").Server[] = [];
const runtimes: AgentServiceRuntime[] = [];
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
	await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime.dispose()));
	await Promise.all(directories.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

async function fixture(traceDir?: string, customRunner?: ModelRunner) {
	let id = 0;
	const runner: ModelRunner = customRunner ?? { async run() { return assistant("HTTP done"); } };
	const runtime = new AgentServiceRuntime({
		generateId: (kind) => `${kind}_${++id}`,
		resolveSessionOptions: (profile) => {
			if (profile.modelId !== MODEL.id) throw new Error("model is not allowlisted");
			return { model: MODEL, createModelRunner: () => runner };
		},
		...(traceDir ? {
			traceConfig: {
				enabled: true, rootDir: traceDir, level: "execution" as const,
				captureArguments: "redacted" as const, captureResults: "redacted" as const,
				maxValueBytes: 4_096, fsyncOnRunFinish: false, retentionDays: 30,
			},
		} : {}),
	});
	runtimes.push(runtime);
	const server = createAgentServiceHttpServer(runtime, {
		authenticate(request) {
			const ownerId = request.headers["x-owner-id"];
			if (typeof ownerId !== "string") throw new Error("missing owner");
			return { ownerId };
		},
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	return { runtime, base: `http://127.0.0.1:${address.port}` };
}

async function request(base: string, path: string, init: RequestInit = {}) {
	return await fetch(`${base}${path}`, {
		...init,
		headers: { "content-type": "application/json", "x-owner-id": "owner-a", ...init.headers },
	});
}

describe("Agent Service HTTP end-to-end", () => {
	it("creates profile/session, sends a message, and exposes Run, Operation and Transcript resources", async () => {
		const { base } = await fixture();
		let response = await request(base, "/v1/agent-profiles", {
			method: "POST",
			body: JSON.stringify({ id: "general", name: "General", modelId: MODEL.id }),
		});
		expect(response.status).toBe(201);

		response = await request(base, "/v1/sessions", {
			method: "POST",
			headers: { "idempotency-key": "create-http" },
			body: JSON.stringify({ agentProfileId: "general", title: "HTTP chat" }),
		});
		expect(response.status).toBe(201);
		const session = await response.json() as { id: string };

		response = await request(base, `/v1/sessions/${session.id}/messages`, {
			method: "POST",
			headers: { "idempotency-key": "message-http" },
			body: JSON.stringify({ content: "hello", delivery: "auto" }),
		});
		expect(response.status).toBe(202);
		const accepted = await response.json() as { runId: string; operationId: string };
		await new Promise((resolve) => setTimeout(resolve, 0));

		response = await request(base, `/v1/runs/${accepted.runId}`);
		expect(await response.json()).toMatchObject({ id: accepted.runId, status: "succeeded" });
		response = await request(base, `/v1/operations/${accepted.operationId}`);
		expect(await response.json()).toMatchObject({ status: "succeeded", type: "message.send" });
		response = await request(base, `/v1/sessions/${session.id}/messages`);
		const transcript = await response.json() as { items: { role: string }[] };
		expect(transcript.items.map((item) => item.role)).toEqual(["user", "assistant"]);

		response = await request(base, `/v1/sessions/${session.id}`, { headers: { "x-owner-id": "owner-b" } });
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ error: { code: "forbidden" } });

		response = await request(base, `/v1/runs/${accepted.runId}/trace`);
		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ error: { code: "trace_not_found" } });
	});

	it("streams ordered Service events over SSE", async () => {
		const { runtime, base } = await fixture();
		await runtime.createAgentProfile({ id: "general", name: "General", modelId: MODEL.id });
		const session = await runtime.createSession(
			{ agentProfileId: "general", idempotencyKey: "create-direct" },
			{ ownerId: "owner-a" },
		);
		const controller = new AbortController();
		const streamResponse = await request(base, `/v1/sessions/${session.id}/events`, { signal: controller.signal });
		expect(streamResponse.status).toBe(200);
		const reader = streamResponse.body!.getReader();
		const nextChunk = reader.read();

		await request(base, `/v1/sessions/${session.id}/messages`, {
			method: "POST",
			headers: { "idempotency-key": "event-message" },
			body: JSON.stringify({ content: "hello" }),
		});
		const chunk = await nextChunk;
		const decoded = new TextDecoder().decode(chunk.value);
		expect(decoded).toContain("event: run.started");
		expect(decoded).toContain(`\"sessionId\":\"${session.id}\"`);
		controller.abort();
	});

	it("bridges Core execution Trace to the authorized Session SSE endpoint", async () => {
		const { runtime, base } = await fixture();
		await runtime.createAgentProfile({ id: "general", name: "General", modelId: MODEL.id });
		const session = await runtime.createSession(
			{ agentProfileId: "general", idempotencyKey: "create-trace" },
			{ ownerId: "owner-a" },
		);
		const controller = new AbortController();
		const streamResponse = await request(base, `/v1/sessions/${session.id}/trace`, { signal: controller.signal });
		const reader = streamResponse.body!.getReader();
		const nextChunk = reader.read();

		await request(base, `/v1/sessions/${session.id}/messages`, {
			method: "POST",
			headers: { "idempotency-key": "trace-message" },
			body: JSON.stringify({ content: "trace me" }),
		});
		const chunk = await nextChunk;
		const decoded = new TextDecoder().decode(chunk.value);
		expect(decoded).toContain("event: agent.run.started");
		expect(decoded).toContain(`\"sessionId\":\"${session.id}\"`);
		controller.abort();
	});

	it("streams an authorized completed Run Trace as NDJSON", async () => {
		const traceDir = await mkdtemp(join(tmpdir(), "ailoha-service-trace-"));
		directories.push(traceDir);
		const { runtime, base } = await fixture(traceDir);
		await runtime.createAgentProfile({ id: "general", name: "General", modelId: MODEL.id });
		const session = await runtime.createSession(
			{ agentProfileId: "general", idempotencyKey: "create-run-trace" },
			{ ownerId: "owner-a" },
		);
		const accepted = await runtime.sendMessage(
			{ sessionId: session.id, message: { role: "user", content: "persist me", timestamp: Date.now() }, idempotencyKey: "run-trace-message" },
			{ ownerId: "owner-a" },
		);
		while ((await runtime.getRun(accepted.runId, { ownerId: "owner-a" }))?.status === "running") {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		let response = await request(base, `/v1/runs/${accepted.runId}/trace`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("application/x-ndjson");
		const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line) as { type: string; runId: string });
		expect(lines.map((event) => event.type)).toEqual([
			"agent.run.started", "context.prepared", "llm.call.started", "llm.call.finished", "agent.run.finished",
		]);
		expect(lines.every((event) => event.runId === accepted.runId)).toBe(true);

		response = await request(base, `/v1/runs/${accepted.runId}/trace`, { headers: { "x-owner-id": "owner-b" } });
		expect(response.status).toBe(403);
	});

	it("returns run_not_finished while a Run is active", async () => {
		const traceDir = await mkdtemp(join(tmpdir(), "ailoha-service-running-trace-"));
		directories.push(traceDir);
		const runner: ModelRunner = {
			async run(_context, { signal }) {
				return await new Promise<AssistantMessage>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			},
		};
		const { runtime, base } = await fixture(traceDir, runner);
		await runtime.createAgentProfile({ id: "general", name: "General", modelId: MODEL.id });
		const session = await runtime.createSession(
			{ agentProfileId: "general", idempotencyKey: "create-running-trace" },
			{ ownerId: "owner-a" },
		);
		const accepted = await runtime.sendMessage(
			{ sessionId: session.id, message: { role: "user", content: "wait", timestamp: Date.now() }, idempotencyKey: "running-trace-message" },
			{ ownerId: "owner-a" },
		);
		const response = await request(base, `/v1/runs/${accepted.runId}/trace`);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ error: { code: "run_not_finished" } });
	});
});
