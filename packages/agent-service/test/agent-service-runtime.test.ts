import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AgentServiceError, AgentServiceRuntime } from "../src/index.js";
import type { AgentContext, AgentModel, ModelRunner } from "@ailoha/agent-core";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const MODEL: AgentModel = {
	id: "service-model",
	name: "Service Model",
	api: "test-api",
	provider: "test-provider",
	baseUrl: "https://invalid.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_000,
};

const assistant = (text: string): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: MODEL.api,
	provider: MODEL.provider,
	model: MODEL.id,
	usage: ZERO_USAGE,
	stopReason: "stop",
	timestamp: 1,
});

const message = (content: string) => ({ role: "user" as const, content, timestamp: 1 });

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

type Step = (context: AgentContext, signal: AbortSignal) => AssistantMessage | Promise<AssistantMessage>;

class ScriptedRunner implements ModelRunner {
	readonly calls: AgentContext["messages"][] = [];
	readonly #steps: Step[];

	constructor(steps: Step[]) {
		this.#steps = [...steps];
	}

	async run(context: AgentContext, options: { readonly signal: AbortSignal }): Promise<AssistantMessage> {
		this.calls.push([...context.messages]);
		const step = this.#steps.shift();
		if (!step) throw new Error("Unexpected model call.");
		return await step(context, options.signal);
	}
}

function serviceFor(runners: ScriptedRunner[], compactor?: NonNullable<Parameters<typeof makeOptions>[1]>) {
	let id = 0;
	return new AgentServiceRuntime({
		generateId: (kind) => `${kind}_${++id}`,
		resolveSessionOptions: (_profile, context) => makeOptions(runners.shift()!, compactor?.(context.sessionId)),
	});
}

function makeOptions(runner: ScriptedRunner, compactor?: (input: any) => any) {
	return {
		model: MODEL,
		createModelRunner: () => runner,
		...(compactor ? { contextManagerOptions: { compactor } } : {}),
	};
}

async function readySession(service: AgentServiceRuntime, ownerId = "owner-a") {
	await service.createAgentProfile({ id: "general", name: "General", modelId: MODEL.id });
	return await service.createSession(
		{ agentProfileId: "general", title: "Chat", idempotencyKey: "create-1" },
		{ ownerId },
	);
}

async function tick(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("AgentServiceRuntime", () => {
	it("runs two Service Sessions concurrently without crossing Run or Transcript state", async () => {
		const leftResponse = deferred<AssistantMessage>();
		const rightResponse = deferred<AssistantMessage>();
		const service = serviceFor([
			new ScriptedRunner([async () => await leftResponse.promise]),
			new ScriptedRunner([async () => await rightResponse.promise]),
		]);
		await service.createAgentProfile({ id: "general", name: "General", modelId: MODEL.id });
		const left = await service.createSession(
			{ agentProfileId: "general", idempotencyKey: "create-left" },
			{ ownerId: "owner-a" },
		);
		const right = await service.createSession(
			{ agentProfileId: "general", idempotencyKey: "create-right" },
			{ ownerId: "owner-a" },
		);
		const [leftRun, rightRun] = await Promise.all([
			service.sendMessage(
				{ sessionId: left.id, message: message("left"), idempotencyKey: "left-message" },
				{ ownerId: "owner-a" },
			),
			service.sendMessage(
				{ sessionId: right.id, message: message("right"), idempotencyKey: "right-message" },
				{ ownerId: "owner-a" },
			),
		]);
		expect(leftRun.runId).not.toBe(rightRun.runId);
		expect((await service.getSession(left.id, { ownerId: "owner-a" }))?.agentStatus).toBe("running");
		expect((await service.getSession(right.id, { ownerId: "owner-a" }))?.agentStatus).toBe("running");

		leftResponse.resolve(assistant("left done"));
		rightResponse.resolve(assistant("right done"));
		await tick();
		const leftMessages = await service.listMessages(left.id, undefined, { ownerId: "owner-a" });
		const rightMessages = await service.listMessages(right.id, undefined, { ownerId: "owner-a" });
		expect(leftMessages.items.map((item) => item.content)).not.toEqual(rightMessages.items.map((item) => item.content));
		await service.dispose();
	});

	it("creates a Session, admits a prompt immediately, then commits the terminal Run and assistant message", async () => {
		const response = deferred<AssistantMessage>();
		const runner = new ScriptedRunner([async () => await response.promise]);
		const service = serviceFor([runner]);
		const session = await readySession(service);

		const accepted = await service.sendMessage(
			{ sessionId: session.id, message: message("hello"), delivery: "auto", idempotencyKey: "message-1" },
			{ ownerId: "owner-a" },
		);
		expect(accepted.acceptedAs).toBe("prompt");
		expect((await service.getRun(accepted.runId, { ownerId: "owner-a" }))?.status).toBe("running");
		expect((await service.listMessages(session.id, undefined, { ownerId: "owner-a" })).items).toHaveLength(1);

		response.resolve(assistant("world"));
		await tick();
		expect((await service.getRun(accepted.runId, { ownerId: "owner-a" }))?.status).toBe("succeeded");
		expect((await service.listMessages(session.id, undefined, { ownerId: "owner-a" })).items.map((item) => item.role)).toEqual([
			"user",
			"assistant",
		]);
		await service.dispose();
	});

	it("routes running auto to follow-up, preserves explicit steer, and does not create extra Runs", async () => {
		const first = deferred<AssistantMessage>();
		const runner = new ScriptedRunner([
			async () => await first.promise,
			async () => assistant("after steer"),
			async () => assistant("after follow-up"),
		]);
		const service = serviceFor([runner]);
		const session = await readySession(service);
		const prompt = await service.sendMessage(
			{ sessionId: session.id, message: message("start"), idempotencyKey: "start" },
			{ ownerId: "owner-a" },
		);
		const steer = await service.sendMessage(
			{ sessionId: session.id, message: message("redirect"), delivery: "steer", idempotencyKey: "steer" },
			{ ownerId: "owner-a" },
		);
		const followUp = await service.sendMessage(
			{ sessionId: session.id, message: message("next"), delivery: "auto", idempotencyKey: "follow" },
			{ ownerId: "owner-a" },
		);
		expect(steer.acceptedAs).toBe("steer");
		expect(followUp.acceptedAs).toBe("follow_up");
		expect(new Set([prompt.runId, steer.runId, followUp.runId]).size).toBe(1);

		first.resolve(assistant("first"));
		await tick();
		expect(runner.calls).toHaveLength(3);
		expect(await service.listRuns(session.id, { ownerId: "owner-a" })).toHaveLength(1);
		await service.dispose();
	});

	it("does not write rejected messages and reuses an idempotent admission result", async () => {
		const response = deferred<AssistantMessage>();
		const runner = new ScriptedRunner([async () => await response.promise]);
		const service = serviceFor([runner]);
		const session = await readySession(service);

		await expect(
			service.sendMessage(
				{ sessionId: session.id, message: message("invalid"), delivery: "steer", idempotencyKey: "bad" },
				{ ownerId: "owner-a" },
			),
		).rejects.toMatchObject({ serviceError: { code: "agent_not_running" } });
		expect((await service.listMessages(session.id, undefined, { ownerId: "owner-a" })).items).toHaveLength(0);

		const input = { sessionId: session.id, message: message("once"), idempotencyKey: "same" };
		const first = await service.sendMessage(input, { ownerId: "owner-a" });
		const duplicate = await service.sendMessage(input, { ownerId: "owner-a" });
		expect(duplicate).toEqual(first);
		expect((await service.listMessages(session.id, undefined, { ownerId: "owner-a" })).items).toHaveLength(1);
		await expect(
			service.sendMessage({ ...input, message: message("different") }, { ownerId: "owner-a" }),
		).rejects.toMatchObject({ serviceError: { code: "idempotency_key_reused" } });

		response.resolve(assistant("done"));
		await tick();
		await service.dispose();
	});

	it("runs manual compact as an idempotent background Operation without changing Transcript", async () => {
		const compactResult = deferred<{ messages: readonly ReturnType<typeof message>[]; beforeTokens: number; afterTokens: number }>();
		const compactor = vi.fn(async () => await compactResult.promise);
		const service = serviceFor([new ScriptedRunner([])], () => compactor);
		const session = await readySession(service);

		const first = await service.compactSession(
			{ sessionId: session.id, idempotencyKey: "compact-once" },
			{ ownerId: "owner-a" },
		);
		const duplicate = await service.compactSession(
			{ sessionId: session.id, idempotencyKey: "compact-once" },
			{ ownerId: "owner-a" },
		);
		expect(duplicate).toEqual(first);
		await vi.waitFor(() => expect(compactor).toHaveBeenCalledTimes(1));
		await expect(
			service.sendMessage(
				{ sessionId: session.id, message: message("blocked"), idempotencyKey: "blocked" },
				{ ownerId: "owner-a" },
			),
		).rejects.toMatchObject({ serviceError: { code: "agent_compacting" } });

		compactResult.resolve({ messages: [message("summary")], beforeTokens: 50, afterTokens: 5 });
		await tick();
		const operation = await service.getOperation(first.operationId, { ownerId: "owner-a" });
		expect(operation).toMatchObject({ status: "succeeded", result: { changed: true, beforeTokens: 50, afterTokens: 5 } });
		expect((await service.listMessages(session.id, undefined, { ownerId: "owner-a" })).items).toHaveLength(0);
		await service.dispose();
	});

	it("does not abort a newer Run when asked to abort an old runId, and enforces owner authorization", async () => {
		const firstResponse = deferred<AssistantMessage>();
		const secondResponse = deferred<AssistantMessage>();
		const runner = new ScriptedRunner([async () => await firstResponse.promise, async () => await secondResponse.promise]);
		const service = serviceFor([runner]);
		const session = await readySession(service);
		const first = await service.sendMessage(
			{ sessionId: session.id, message: message("first"), idempotencyKey: "first" },
			{ ownerId: "owner-a" },
		);
		await service.abortRun(session.id, first.runId, "abort-first", { ownerId: "owner-a" });
		firstResponse.resolve(assistant("late"));
		await tick();
		expect((await service.getRun(first.runId, { ownerId: "owner-a" }))?.status).toBe("aborted");

		const second = await service.sendMessage(
			{ sessionId: session.id, message: message("second"), idempotencyKey: "second" },
			{ ownerId: "owner-a" },
		);
		const oldAbort = await service.abortRun(session.id, first.runId, "abort-old", { ownerId: "owner-a" });
		expect(oldAbort.result).toEqual({ activeRunMatched: false });
		expect((await service.getRun(second.runId, { ownerId: "owner-a" }))?.status).toBe("running");
		await expect(
			service.sendRunMessage(
				{ runId: first.runId, message: message("must not reach new run"), delivery: "steer", idempotencyKey: "old-steer" },
				{ ownerId: "owner-a" },
			),
		).rejects.toMatchObject({ serviceError: { code: "run_not_active" } });
		await expect(service.getSession(session.id, { ownerId: "owner-b" })).rejects.toBeInstanceOf(AgentServiceError);

		secondResponse.resolve(assistant("done"));
		await tick();
		await service.dispose();
	});

	it("keeps a Session usable after a failed Run", async () => {
		const runner = new ScriptedRunner([
			async () => { throw new Error("provider failed"); },
			async () => assistant("recovered on next run"),
		]);
		const service = serviceFor([runner]);
		const session = await readySession(service);
		const failed = await service.sendMessage(
			{ sessionId: session.id, message: message("fail"), idempotencyKey: "fail" },
			{ ownerId: "owner-a" },
		);
		await vi.waitFor(async () => {
			expect((await service.getRun(failed.runId, { ownerId: "owner-a" }))?.status).toBe("failed");
		});
		expect((await service.getSession(session.id, { ownerId: "owner-a" }))?.agentStatus).toBe("idle");

		const next = await service.sendMessage(
			{ sessionId: session.id, message: message("retry"), idempotencyKey: "retry" },
			{ ownerId: "owner-a" },
		);
		await vi.waitFor(async () => {
			expect((await service.getRun(next.runId, { ownerId: "owner-a" }))?.status).toBe("succeeded");
		});
		await service.dispose();
	});

	it("close aborts and awaits an active Run, then permanently rejects new admission", async () => {
		const response = deferred<AssistantMessage>();
		const service = serviceFor([new ScriptedRunner([async () => await response.promise])]);
		const session = await readySession(service);
		const accepted = await service.sendMessage(
			{ sessionId: session.id, message: message("long run"), idempotencyKey: "long" },
			{ ownerId: "owner-a" },
		);
		const closing = service.closeSession(session.id, "close", { ownerId: "owner-a" });
		response.resolve(assistant("late"));
		await closing;
		expect((await service.getRun(accepted.runId, { ownerId: "owner-a" }))?.status).toBe("aborted");
		expect((await service.getSession(session.id, { ownerId: "owner-a" }))?.status).toBe("closed");
		await expect(
			service.sendMessage(
				{ sessionId: session.id, message: message("too late"), idempotencyKey: "too-late" },
				{ ownerId: "owner-a" },
			),
		).rejects.toMatchObject({ serviceError: { code: "session_not_ready" } });
		await service.dispose();
	});
});
