import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { Agent, AgentStateError, DefaultContextManager, ToolManager, createAbortError } from "../src/index.js";
import type { AgentInputMessage, AgentModel, CompactorInput, ModelRunner } from "../src/index.js";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const MODEL: AgentModel = {
	id: "compact-model",
	name: "Compact Model",
	api: "test-api",
	provider: "test-provider",
	baseUrl: "https://invalid.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_000,
};

const user = (content: string): AgentInputMessage => ({ role: "user", content, timestamp: 1 });
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

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function makeAgent(context: DefaultContextManager, response = assistant("done")): Promise<Agent> {
	const runner: ModelRunner = { async run() { return response; } };
	const tools = new ToolManager();
	await tools.initialize([], { sessionId: "manual-compact", model: MODEL, signal: new AbortController().signal });
	return new Agent({ sessionId: "manual-compact", model: MODEL, modelRunner: runner, contextManager: context, toolManager: tools });
}

describe("Agent manual compaction", () => {
	it("compacts a frozen committed snapshot without changing the turn counter", async () => {
		const compact = vi.fn(async (input: CompactorInput) => {
			expect(input.reason).toBe("manual");
			expect(Object.isFrozen(input.messages)).toBe(true);
			return { messages: [user("summary")], beforeTokens: 100, afterTokens: 10 };
		});
		const context = new DefaultContextManager({ messages: [user("old")], maxTurns: 3, compactor: compact });
		context.consumeTurn();
		const agent = await makeAgent(context);

		await expect(agent.compact()).resolves.toEqual({ changed: true, beforeTokens: 100, afterTokens: 10 });
		expect(context.snapshot().messages).toEqual([user("summary")]);
		expect(context.turnCount).toBe(1);
		expect(agent.state.status).toBe("idle");
		await agent.dispose();
	});

	it("is a successful no-op when no compactor is configured", async () => {
		const context = new DefaultContextManager({ messages: [user("kept")] });
		const agent = await makeAgent(context);
		await expect(agent.compact()).resolves.toEqual({ changed: false });
		expect(context.snapshot().messages).toEqual([user("kept")]);
		await agent.dispose();
	});

	it("keeps the previous snapshot on failure and abort", async () => {
		const failure = new DefaultContextManager({
			messages: [user("original")],
			compactor: async () => { throw new Error("compact failed"); },
		});
		const failedAgent = await makeAgent(failure);
		await expect(failedAgent.compact()).rejects.toThrow("compact failed");
		expect(failure.snapshot().messages).toEqual([user("original")]);
		await failedAgent.dispose();

		const pending = deferred<{ messages: readonly AgentInputMessage[] }>();
		const aborted = new DefaultContextManager({ messages: [user("original")], compactor: async () => await pending.promise });
		const abortedAgent = await makeAgent(aborted);
		const controller = new AbortController();
		const compacting = abortedAgent.compact({ signal: controller.signal });
		controller.abort(createAbortError("stop"));
		pending.resolve({ messages: [user("must not commit")] });
		await expect(compacting).rejects.toMatchObject({ name: "AbortError" });
		expect(aborted.snapshot().messages).toEqual([user("original")]);
		await abortedAgent.dispose();
	});

	it("excludes prompts while compacting and dispose cancels then waits", async () => {
		const pending = deferred<{ messages: readonly AgentInputMessage[] }>();
		let signal!: AbortSignal;
		const context = new DefaultContextManager({
			compactor: async (input) => {
				signal = input.signal;
				return await pending.promise;
			},
		});
		const agent = await makeAgent(context);
		const compacting = agent.compact();
		expect(agent.state.status).toBe("compacting");
		await expect(agent.prompt("blocked")).rejects.toBeInstanceOf(AgentStateError);
		expect(() => agent.steer(user("blocked"))).toThrow(AgentStateError);

		const disposing = agent.dispose();
		expect(signal.aborted).toBe(true);
		pending.resolve({ messages: [user("late")] });
		await expect(compacting).rejects.toMatchObject({ name: "AbortError" });
		await disposing;
	});
});
