import type { AddressInfo } from "node:net";
import { Type } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ChatCompletionChunk,
	ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions.js";
import { ChatCompletionsAdapter } from "@ailoha/chat-completions-adapter";
import type { ToolManager } from "@ailoha/agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { AgentServiceRuntime, createAgentServiceHttpServer } from "../src/index.js";

const MODEL: Model<Api> = {
	id: "service-adapter-model",
	name: "Service Adapter Model",
	api: "openai-completions",
	provider: "deterministic-provider",
	baseUrl: "https://provider.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_000,
};

interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

let chunkId = 0;

function chunk(
	delta: ChatCompletionChunk.Choice.Delta,
	finishReason: ChatCompletionChunk.Choice["finish_reason"] = null,
): ChatCompletionChunk {
	return {
		id: `service-chunk-${++chunkId}`,
		choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
		created: 1,
		model: MODEL.id,
		object: "chat.completion.chunk",
	};
}

function sse(chunks: readonly ChatCompletionChunk[]): Response {
	return new Response(`${chunks.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("")}data: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream", "x-request-id": "service-e2e" },
	});
}

function textResponse(text: string): Response {
	return sse([chunk({ content: text }, "stop")]);
}

function toolResponse(id: string, name: string, args: Record<string, unknown>): Response {
	return sse([
		chunk({
			tool_calls: [{
				index: 0,
				id,
				type: "function",
				function: { name, arguments: JSON.stringify(args) },
			}],
		}, "tool_calls"),
	]);
}

type TransportHandler = (
	sessionId: string,
	payload: ChatCompletionCreateParamsStreaming,
	callNumber: number,
) => Response | Promise<Response>;

interface HarnessOptions {
	readonly transport: TransportHandler;
	readonly configureTools?: (manager: ToolManager, sessionId: string) => void;
}

interface AcceptedRun {
	readonly runId: string;
	readonly operationId: string;
	readonly acceptedAs: "prompt" | "steer" | "follow_up";
}

interface RunResource {
	readonly id: string;
	readonly status: "running" | "succeeded" | "failed" | "aborted";
	readonly error?: {
		readonly code: string;
		readonly message: string;
		readonly details?: Readonly<Record<string, unknown>>;
	};
}

interface TranscriptResource {
	readonly items: readonly {
		readonly role: "user" | "assistant";
		readonly content: unknown;
		readonly runId: string;
	}[];
}

interface Harness {
	readonly baseUrl: string;
	readonly calls: ReadonlyMap<string, ChatCompletionCreateParamsStreaming[]>;
	createProfile(options?: { readonly id?: string; readonly maxTurns?: number; readonly tools?: readonly string[] }): Promise<string>;
	createSession(profileId: string, key: string): Promise<string>;
	postMessage(sessionId: string, content: string, key: string): Promise<{ readonly response: Response; readonly body: AcceptedRun }>;
	postSteer(runId: string, content: string, key: string): Promise<{ readonly response: Response; readonly body: AcceptedRun }>;
	postFollowUp(runId: string, content: string, key: string): Promise<{ readonly response: Response; readonly body: AcceptedRun }>;
	waitForRun(runId: string): Promise<RunResource>;
	transcript(sessionId: string): Promise<TranscriptResource>;
}

const servers: import("node:http").Server[] = [];
const runtimes: AgentServiceRuntime[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
	await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime.dispose()));
});

async function startHarness(options: HarnessOptions): Promise<Harness> {
	let id = 0;
	const calls = new Map<string, ChatCompletionCreateParamsStreaming[]>();
	const runtime = new AgentServiceRuntime({
		generateId: (kind) => `${kind}_${++id}`,
		resolveSessionOptions(profile, sessionContext) {
			const sessionCalls: ChatCompletionCreateParamsStreaming[] = [];
			calls.set(sessionContext.sessionId, sessionCalls);
			const injectedFetch: typeof globalThis.fetch = async (input, init) => {
				const request = new Request(input, init);
				const payload = JSON.parse(await request.text()) as ChatCompletionCreateParamsStreaming;
				sessionCalls.push(structuredClone(payload));
				return await options.transport(sessionContext.sessionId, payload, sessionCalls.length);
			};
			const adapter = new ChatCompletionsAdapter({ model: MODEL, apiKey: "service-test-key", fetch: injectedFetch });
			return {
				model: MODEL,
				createModelRunner: () => ({
					run: (context, { signal }) => adapter.complete({
						systemPrompt: context.systemPrompt,
						messages: [...context.messages],
						tools: [...context.tools],
					}, { signal }),
				}),
				contextManagerOptions: {
					systemPrompts: profile.systemPrompts,
					maxTurns: profile.maxTurns,
				},
				configureTools: (manager: ToolManager) => options.configureTools?.(manager, sessionContext.sessionId),
				toolRequests: profile.tools,
			};
		},
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
	const baseUrl = `http://127.0.0.1:${address.port}`;

	async function request(path: string, init: RequestInit = {}): Promise<Response> {
		return await fetch(`${baseUrl}${path}`, {
			...init,
			headers: { "content-type": "application/json", "x-owner-id": "service-e2e-owner", ...init.headers },
		});
	}

	async function json<T>(response: Response): Promise<T> {
		return await response.json() as T;
	}

	return {
		baseUrl,
		calls,
		async createProfile(profileOptions = {}) {
			const profileId = profileOptions.id ?? `profile-${id + 1}`;
			const response = await request("/v1/agent-profiles", {
				method: "POST",
				body: JSON.stringify({
					id: profileId,
					name: "Adapter Service E2E",
					modelId: MODEL.id,
					...(profileOptions.maxTurns === undefined ? {} : { maxTurns: profileOptions.maxTurns }),
					tools: (profileOptions.tools ?? []).map((name) => ({ name })),
				}),
			});
			expect(response.status).toBe(201);
			return profileId;
		},
		async createSession(profileId, key) {
			const response = await request("/v1/sessions", {
				method: "POST",
				headers: { "idempotency-key": key },
				body: JSON.stringify({ agentProfileId: profileId, title: key }),
			});
			expect(response.status).toBe(201);
			return (await json<{ readonly id: string }>(response)).id;
		},
		async postMessage(sessionId, content, key) {
			const response = await request(`/v1/sessions/${sessionId}/messages`, {
				method: "POST",
				headers: { "idempotency-key": key },
				body: JSON.stringify({ content, delivery: "prompt" }),
			});
			const body = await json<AcceptedRun>(response.clone());
			return { response, body };
		},
		async postFollowUp(runId, content, key) {
			const response = await request(`/v1/runs/${runId}/follow-ups`, {
				method: "POST",
				headers: { "idempotency-key": key },
				body: JSON.stringify({ content }),
			});
			const body = await json<AcceptedRun>(response.clone());
			return { response, body };
		},
		async postSteer(runId, content, key) {
			const response = await request(`/v1/runs/${runId}/steer`, {
				method: "POST",
				headers: { "idempotency-key": key },
				body: JSON.stringify({ content }),
			});
			const body = await json<AcceptedRun>(response.clone());
			return { response, body };
		},
		async waitForRun(runId) {
			for (let attempt = 0; attempt < 200; attempt++) {
				const response = await request(`/v1/runs/${runId}`);
				expect(response.status).toBe(200);
				const run = await json<RunResource>(response);
				if (run.status !== "running") return run;
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			throw new Error(`Run ${runId} did not finish.`);
		},
		async transcript(sessionId) {
			const response = await request(`/v1/sessions/${sessionId}/messages`);
			expect(response.status).toBe(200);
			return await json<TranscriptResource>(response);
		},
	};
}

function assistantText(transcript: TranscriptResource): string[] {
	return transcript.items
		.filter((message) => message.role === "assistant")
		.map((message) => {
			if (!Array.isArray(message.content)) return "";
			return message.content
				.filter((block): block is { readonly type: "text"; readonly text: string } => (
					typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block
				))
				.map((block) => block.text)
				.join("");
		});
}

describe("Agent Service + Chat Completions adapter HTTP E2E", () => {
	it("runs multiple Sessions concurrently while keeping their contexts isolated", async () => {
		let activeFirstCalls = 0;
		let maxActiveFirstCalls = 0;
		let firstCalls = 0;
		const releaseFirstWave = deferred<void>();
		const harness = await startHarness({
			async transport(_sessionId, payload, callNumber) {
				const serialized = JSON.stringify(payload.messages);
				if (callNumber === 1) {
					activeFirstCalls++;
					maxActiveFirstCalls = Math.max(maxActiveFirstCalls, activeFirstCalls);
					if (++firstCalls === 2) releaseFirstWave.resolve();
					await releaseFirstWave.promise;
					activeFirstCalls--;
				}
				if (serialized.includes("ALPHA-7391")) {
					expect(serialized).not.toContain("BETA-2846");
					return textResponse(callNumber === 1 ? "已记住 ALPHA-7391。" : "你的代码是 ALPHA-7391。");
				}
				expect(serialized).toContain("BETA-2846");
				expect(serialized).not.toContain("ALPHA-7391");
				return textResponse(callNumber === 1 ? "已记住 BETA-2846。" : "你的代码是 BETA-2846。");
			},
		});
		const profile = await harness.createProfile();
		const [sessionA, sessionB] = await Promise.all([
			harness.createSession(profile, "parallel-session-a"),
			harness.createSession(profile, "parallel-session-b"),
		]);
		const [firstA, firstB] = await Promise.all([
			harness.postMessage(sessionA, "请记住 ALPHA-7391", "parallel-first-a"),
			harness.postMessage(sessionB, "请记住 BETA-2846", "parallel-first-b"),
		]);
		expect(firstA.response.status).toBe(202);
		expect(firstB.response.status).toBe(202);
		await Promise.all([harness.waitForRun(firstA.body.runId), harness.waitForRun(firstB.body.runId)]);

		const [followA, followB] = await Promise.all([
			harness.postMessage(sessionA, "我的代码是什么？", "parallel-follow-a"),
			harness.postMessage(sessionB, "我的代码是什么？", "parallel-follow-b"),
		]);
		await Promise.all([harness.waitForRun(followA.body.runId), harness.waitForRun(followB.body.runId)]);

		expect(maxActiveFirstCalls).toBe(2);
		expect(assistantText(await harness.transcript(sessionA))).toEqual(["已记住 ALPHA-7391。", "你的代码是 ALPHA-7391。"]);
		expect(assistantText(await harness.transcript(sessionB))).toEqual(["已记住 BETA-2846。", "你的代码是 BETA-2846。"]);
		expect(harness.calls.get(sessionA)).toHaveLength(2);
		expect(harness.calls.get(sessionB)).toHaveLength(2);
	});

	it("keeps ordered context across a sustained three-run conversation", async () => {
		const harness = await startHarness({
			transport(_sessionId, payload, callNumber) {
				const history = JSON.stringify(payload.messages);
				if (callNumber === 1) {
					expect(payload.messages.map((message) => message.role)).toEqual(["user"]);
					return textResponse("记住了，项目代号是 ORBIT-928。");
				}
				if (callNumber === 2) {
					expect(payload.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
					expect(history).toContain("ORBIT-928");
					return textResponse("负责人是小林，我也记住了。");
				}
				expect(payload.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
				expect(history).toContain("ORBIT-928");
				expect(history).toContain("小林");
				return textResponse("项目 ORBIT-928 的负责人是小林。");
			},
		});
		const profile = await harness.createProfile();
		const session = await harness.createSession(profile, "conversation-session");
		for (const [index, prompt] of [
			"请记住项目代号 ORBIT-928。",
			"再记住负责人是小林。",
			"项目代号和负责人分别是什么？",
		].entries()) {
			const accepted = await harness.postMessage(session, prompt, `conversation-${index}`);
			expect(accepted.response.status).toBe(202);
			expect((await harness.waitForRun(accepted.body.runId)).status).toBe("succeeded");
		}
		const transcript = await harness.transcript(session);
		expect(transcript.items.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
		expect(assistantText(transcript).at(-1)).toBe("项目 ORBIT-928 的负责人是小林。");
	});

	it("accepts a pure conversational follow-up into the active Run", async () => {
		const firstCallStarted = deferred<void>();
		const releaseFirstCall = deferred<void>();
		const harness = await startHarness({
			async transport(_sessionId, payload, callNumber) {
				if (callNumber === 1) {
					firstCallStarted.resolve();
					await releaseFirstCall.promise;
					return textResponse("第一问已经处理。");
				}
				expect(payload.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
				expect(JSON.stringify(payload.messages)).toContain("请顺便告诉我项目代号");
				return textResponse("补充回答：项目代号是 FOLLOW-42。");
			},
		});
		const profile = await harness.createProfile();
		const session = await harness.createSession(profile, "active-follow-up-session");
		const first = await harness.postMessage(session, "处理第一问", "active-first");
		expect(first.response.status).toBe(202);
		await firstCallStarted.promise;
		const followUp = await harness.postFollowUp(first.body.runId, "请顺便告诉我项目代号 FOLLOW-42", "active-follow-up");
		expect(followUp.response.status).toBe(202);
		expect(followUp.body).toMatchObject({ acceptedAs: "follow_up", runId: first.body.runId });
		releaseFirstCall.resolve();
		expect((await harness.waitForRun(first.body.runId)).status).toBe("succeeded");

		const transcript = await harness.transcript(session);
		expect(transcript.items.map((message) => message.role)).toEqual(["user", "user", "assistant"]);
		expect(assistantText(transcript)).toEqual(["补充回答：项目代号是 FOLLOW-42。"]);
		expect(harness.calls.get(session)).toHaveLength(2);
	});

	it("steers an active tool turn through HTTP and keeps the same Run", async () => {
		const toolStarted = deferred<void>();
		const releaseTool = deferred<void>();
		const harness = await startHarness({
			transport(_sessionId, payload, callNumber) {
				if (callNumber === 1) return toolResponse("lookup-before-steer", "lookup", { topic: "旧方向" });

				expect(payload.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "user"]);
				expect(payload.messages.at(-2)).toMatchObject({
					role: "tool",
					tool_call_id: "lookup-before-steer",
					content: '{"result":"旧方向资料"}',
				});
				expect(payload.messages.at(-1)).toMatchObject({ role: "user", content: "改成新方向，并据此回答" });
			return textResponse("已转向新方向回答。");
			},
			configureTools(manager) {
				manager.register("lookup", () => ({
					name: "lookup",
					description: "Look up a topic",
					parameters: Type.Object({ topic: Type.String() }, { additionalProperties: false }),
					async execute() {
						toolStarted.resolve();
						await releaseTool.promise;
						return { content: '{"result":"旧方向资料"}' };
					},
				}));
			},
		});
		const profile = await harness.createProfile({ tools: ["lookup"] });
		const session = await harness.createSession(profile, "active-steer-session");
		const first = await harness.postMessage(session, "先查询旧方向", "active-steer-first");
		expect(first.response.status).toBe(202);
		await toolStarted.promise;

		const steer = await harness.postSteer(first.body.runId, "改成新方向，并据此回答", "active-steer");
		expect(steer.response.status).toBe(202);
		expect(steer.body).toMatchObject({ acceptedAs: "steer", runId: first.body.runId });
		releaseTool.resolve();
		expect((await harness.waitForRun(first.body.runId)).status).toBe("succeeded");

		const transcript = await harness.transcript(session);
		expect(transcript.items.map((message) => message.role)).toEqual(["user", "user", "assistant"]);
		expect(new Set(transcript.items.map((message) => message.runId))).toEqual(new Set([first.body.runId]));
		expect(assistantText(transcript)).toEqual(["已转向新方向回答。"]);
		expect(harness.calls.get(session)).toHaveLength(2);
	});

	it("uses remembered conversational state in a later tool-assisted follow-up", async () => {
		const harness = await startHarness({
			transport(_sessionId, payload, callNumber) {
				const history = JSON.stringify(payload.messages);
				if (callNumber === 1) return textResponse("记住了，Widget-A 单价是 19.90 元。");
				if (callNumber === 2) {
					expect(history).toContain("Widget-A 单价是 19.90");
					expect(history).toContain("那买 5 个多少钱");
					return toolResponse("multiply-follow-up", "multiply", { left: 19.9, right: 5 });
				}
				expect(payload.messages.map((message) => message.role)).toEqual([
					"user", "assistant", "user", "assistant", "tool",
				]);
				expect(payload.messages.at(-1)).toMatchObject({
					role: "tool",
					tool_call_id: "multiply-follow-up",
					content: '{"result":99.5}',
				});
				return textResponse("5 个 Widget-A 共 99.50 元。");
			},
			configureTools(manager) {
				manager.register("multiply", () => ({
					name: "multiply",
					description: "Multiply two numbers",
					parameters: Type.Object({ left: Type.Number(), right: Type.Number() }, { additionalProperties: false }),
					async execute(call) {
						return { content: JSON.stringify({ result: Number(call.arguments.left) * Number(call.arguments.right) }) };
					},
				}));
			},
		});
		const profile = await harness.createProfile({ tools: ["multiply"] });
		const session = await harness.createSession(profile, "tool-follow-up-session");
		const first = await harness.postMessage(session, "请记住 Widget-A 单价是 19.90 元", "tool-memory");
		await harness.waitForRun(first.body.runId);
		const followUp = await harness.postMessage(session, "那买 5 个多少钱？", "tool-follow-up");
		expect((await harness.waitForRun(followUp.body.runId)).status).toBe("succeeded");

		const transcript = await harness.transcript(session);
		expect(assistantText(transcript)).toEqual(["记住了，Widget-A 单价是 19.90 元。", "5 个 Widget-A 共 99.50 元。"]);
		expect(harness.calls.get(session)).toHaveLength(3);
	});

	it("fails an infinite tool loop at maxTurns and rejects later prompts at the HTTP boundary", async () => {
		const harness = await startHarness({
			transport(_sessionId, _payload, callNumber) {
				return toolResponse(`loop-${callNumber}`, "noop", {});
			},
			configureTools(manager) {
				manager.register("noop", () => ({
					name: "noop",
					description: "No-op test tool",
					parameters: Type.Object({}, { additionalProperties: false }),
					async execute() { return { content: "ok" }; },
				}));
			},
		});
		const profile = await harness.createProfile({ maxTurns: 3, tools: ["noop"] });
		const session = await harness.createSession(profile, "turn-limit-session");
		const accepted = await harness.postMessage(session, "一直调用工具", "turn-limit-first");
		expect(accepted.response.status).toBe(202);
		const failedRun = await harness.waitForRun(accepted.body.runId);
		expect(failedRun).toMatchObject({
			status: "failed",
			error: {
				code: "agent_turn_limit_reached",
				details: { maxTurns: 3, turnCount: 3 },
			},
		});
		expect(harness.calls.get(session)).toHaveLength(3);
		expect((await harness.transcript(session)).items.map((message) => message.role)).toEqual(["user"]);

		const rejected = await harness.postMessage(session, "再试一次", "turn-limit-second");
		expect(rejected.response.status).toBe(409);
		expect(rejected.body).toMatchObject({
			error: { code: "agent_turn_limit_reached", details: { maxTurns: 3, turnCount: 3 } },
		});
		expect(harness.calls.get(session)).toHaveLength(3);
	});
});
