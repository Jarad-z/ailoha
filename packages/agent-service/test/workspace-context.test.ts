import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { AgentContext, AgentModel, ModelRunner } from "@ailoha/agent-core";
import { afterEach, describe, expect, it } from "vitest";
import {
	AgentServiceRuntime,
	createAgentServiceHttpServer,
	serviceFailure,
} from "../src/index.js";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const MODEL: AgentModel = {
	id: "workspace-service-model",
	name: "Workspace Service Model",
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

class RecordingRunner implements ModelRunner {
	readonly contexts: AgentContext[] = [];

	async run(context: AgentContext): Promise<AssistantMessage> {
		this.contexts.push(structuredClone(context));
		return assistant("service done");
	}
}

const runtimes: AgentServiceRuntime[] = [];
const servers: import("node:http").Server[] = [];
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))));
	await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime.dispose()));
	await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function createWorkspace(marker: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "ailoha-service-workspace-test-"));
	roots.push(root);
	const cwd = join(root, "workspace");
	await mkdir(cwd);
	await writeFile(join(cwd, "AGENTS.md"), marker, "utf8");
	return cwd;
}

async function waitForRun(runtime: AgentServiceRuntime, runId: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const run = await runtime.getRun(runId, { ownerId: "owner-a" });
		if (run?.status !== "running") return;
		await new Promise((resolveWait) => setTimeout(resolveWait, 0));
	}
	throw new Error(`Run ${runId} did not finish.`);
}

describe("Agent Service workspace context", () => {
	it("resolves a logical workspaceId and injects AGENTS.md without adding it to the transcript", async () => {
		const cwd = await createWorkspace("SERVICE_WORKSPACE_MARKER");
		const runner = new RecordingRunner();
		const observedWorkspaceIds: Array<string | undefined> = [];
		const runtime = new AgentServiceRuntime({
			resolveSessionOptions(profile, context) {
				observedWorkspaceIds.push(context.workspaceId);
				return {
					model: MODEL,
					workspace: { cwd },
					createModelRunner: () => runner,
					contextManagerOptions: { systemPrompts: profile.systemPrompts },
				};
			},
		});
		runtimes.push(runtime);
		await runtime.createAgentProfile({
			id: "workspace-profile",
			name: "Workspace profile",
			modelId: MODEL.id,
			systemPrompts: ["service base prompt"],
		});

		const session = await runtime.createSession({
			agentProfileId: "workspace-profile",
			workspaceId: "workspace-a",
			idempotencyKey: "create-workspace-session",
		}, { ownerId: "owner-a" });
		expect(observedWorkspaceIds).toEqual(["workspace-a"]);
		expect(session).toMatchObject({
			workspaceId: "workspace-a",
			workspace: { cwd: resolve(cwd) },
		});

		const accepted = await runtime.sendMessage({
			sessionId: session.id,
			message: { role: "user", content: "generic probe", timestamp: Date.now() },
			idempotencyKey: "workspace-message",
		}, { ownerId: "owner-a" });
		await waitForRun(runtime, accepted.runId);

		expect(runner.contexts).toHaveLength(1);
		expect(runner.contexts[0].systemPrompt).toContain("service base prompt");
		expect(runner.contexts[0].systemPrompt).toContain("SERVICE_WORKSPACE_MARKER");
		expect(runner.contexts[0].systemPromptMetadata).toMatchObject({ workspaceInstructionsLoaded: true });
		const transcript = await runtime.listMessages(session.id, undefined, { ownerId: "owner-a" });
		expect(JSON.stringify(transcript)).not.toContain("SERVICE_WORKSPACE_MARKER");
		expect(transcript.items.map((item) => item.role)).toEqual(["user", "assistant"]);
	});

	it("accepts only workspaceId over HTTP and keeps path resolution in the host", async () => {
		const cwd = await createWorkspace("HTTP_WORKSPACE_MARKER");
		const runner = new RecordingRunner();
		let resolverCalls = 0;
		const runtime = new AgentServiceRuntime({
			resolveSessionOptions(profile, context) {
				resolverCalls += 1;
				if (context.workspaceId !== "workspace-a") {
					throw serviceFailure("workspace_not_allowed", "Unknown workspaceId.", 400);
				}
				return {
					model: MODEL,
					workspace: { cwd },
					createModelRunner: () => runner,
					contextManagerOptions: { systemPrompts: profile.systemPrompts },
				};
			},
		});
		runtimes.push(runtime);
		await runtime.createAgentProfile({ id: "http-workspace", name: "HTTP workspace", modelId: MODEL.id });
		const server = createAgentServiceHttpServer(runtime, {
			authenticate: () => ({ ownerId: "owner-a" }),
		});
		servers.push(server);
		await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
		const address = server.address() as AddressInfo;
		const base = `http://127.0.0.1:${address.port}`;

		let response = await fetch(`${base}/v1/sessions`, {
			method: "POST",
			headers: { "content-type": "application/json", "idempotency-key": "raw-cwd" },
			body: JSON.stringify({ agentProfileId: "http-workspace", cwd }),
		});
		expect(response.status).toBe(400);
		expect(resolverCalls).toBe(0);

		response = await fetch(`${base}/v1/sessions`, {
			method: "POST",
			headers: { "content-type": "application/json", "idempotency-key": "unknown-workspace" },
			body: JSON.stringify({ agentProfileId: "http-workspace", workspaceId: "unknown" }),
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "workspace_not_allowed" } });

		response = await fetch(`${base}/v1/sessions`, {
			method: "POST",
			headers: { "content-type": "application/json", "idempotency-key": "valid-workspace" },
			body: JSON.stringify({ agentProfileId: "http-workspace", workspaceId: "workspace-a" }),
		});
		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({
			workspaceId: "workspace-a",
			workspace: { cwd: resolve(cwd) },
		});
	});
});
