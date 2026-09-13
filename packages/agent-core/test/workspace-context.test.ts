import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DefaultContextManager,
	InMemoryTraceSink,
	MAX_AGENTS_MD_BYTES,
	Session,
	SessionRuntime,
	ToolManager,
	WorkspaceContextError,
	loadWorkspaceInstructions,
	resolveSessionWorkspace,
} from "../src/index.js";
import type {
	AgentContext,
	AgentModel,
	ModelRunner,
	WorkspaceInstructionFile,
} from "../src/index.js";

const NOW = 1_789_123_456_000;
const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const MODEL: AgentModel = {
	id: "workspace-test-model",
	name: "Workspace Test Model",
	api: "test-api",
	provider: "test-provider",
	baseUrl: "https://invalid.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_000,
};

function assistant(text: string, content: AssistantMessage["content"] = [{ type: "text", text }]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: ZERO_USAGE,
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: NOW,
	};
}

class RecordingRunner implements ModelRunner {
	readonly contexts: Array<{
		readonly systemPrompt: string;
		readonly systemPromptMetadata: AgentContext["systemPromptMetadata"];
		readonly messages: AgentContext["messages"];
	}> = [];
	readonly #steps: Array<(context: AgentContext) => AssistantMessage | Promise<AssistantMessage>>;

	constructor(steps: Array<(context: AgentContext) => AssistantMessage | Promise<AssistantMessage>>) {
		this.#steps = [...steps];
	}

	async run(context: AgentContext): Promise<AssistantMessage> {
		this.contexts.push({
			systemPrompt: context.systemPrompt,
			systemPromptMetadata: context.systemPromptMetadata,
			messages: structuredClone(context.messages),
		});
		const step = this.#steps.shift();
		if (!step) throw new Error("Unexpected model call.");
		return await step(context);
	}
}

const temporaryRoots: string[] = [];

async function temporaryWorkspace(name = "workspace"): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "ailoha-workspace-context-test-"));
	temporaryRoots.push(root);
	const workspace = join(root, name);
	await mkdir(workspace);
	return workspace;
}

afterEach(async () => {
	for (const root of temporaryRoots.splice(0)) {
		expect(dirname(root)).toBe(resolve(tmpdir()));
		expect(basename(root).startsWith("ailoha-workspace-context-test-")).toBe(true);
		await rm(root, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
});

describe("Session workspace", () => {
	it("defaults to the Session creation cwd and resolves relative workspace paths", async () => {
		const session = await Session.create({
			model: MODEL,
			createModelRunner: () => new RecordingRunner([]),
		});
		expect(session.workspace.cwd).toBe(resolve(process.cwd()));
		await session.dispose();

		const cwd = await temporaryWorkspace();
		const relativeCwd = relative(process.cwd(), cwd);
		expect(resolveSessionWorkspace({ cwd: relativeCwd }, process.cwd()).cwd).toBe(resolve(cwd));
	});

	it("passes the same workspace object to every factory and managed handle", async () => {
		const cwd = await temporaryWorkspace();
		const observed: unknown[] = [];
		const runner = new RecordingRunner([async () => assistant("done")]);
		const runtime = new SessionRuntime();
		const handle = await runtime.createSession({
			id: "workspace-factories",
			session: {
				model: MODEL,
				workspace: { cwd },
				createModelRunner(context) {
					observed.push(context.workspace);
					return runner;
				},
				createContextManager(context) {
					observed.push(context.workspace);
					return new DefaultContextManager({ workspace: context.workspace });
				},
				createToolManager(context) {
					observed.push(context.workspace);
					return new ToolManager();
				},
				configureTools(_manager, context) {
					observed.push(context.workspace);
				},
			},
		});

		expect(handle.workspace.cwd).toBe(resolve(cwd));
		expect(Object.isFrozen(handle.workspace)).toBe(true);
		expect(observed).toEqual([handle.workspace, handle.workspace, handle.workspace, handle.workspace]);
		expect(handle.snapshot().workspace).toBe(handle.workspace);
		expect(runtime.listSessions()[0].workspace).toBe(handle.workspace);
		await runtime.dispose();
	});

	it("forces the Session workspace into the default ContextManager", async () => {
		const cwd = await temporaryWorkspace("selected");
		const ignoredCwd = await temporaryWorkspace("ignored");
		await writeFile(join(cwd, "AGENTS.md"), "selected-marker", "utf8");
		await writeFile(join(ignoredCwd, "AGENTS.md"), "ignored-marker", "utf8");
		const runner = new RecordingRunner([async () => assistant("done")]);
		const session = await Session.create({
			model: MODEL,
			workspace: { cwd },
			createModelRunner: () => runner,
			contextManagerOptions: {
				workspace: resolveSessionWorkspace({ cwd: ignoredCwd }, process.cwd()),
			},
		});

		await session.agent.prompt("probe");
		expect(runner.contexts[0].systemPrompt).toContain("selected-marker");
		expect(runner.contexts[0].systemPrompt).not.toContain("ignored-marker");
		await session.dispose();
	});

	it("rejects an invalid cwd before invoking factories", async () => {
		const createModelRunner = vi.fn(() => new RecordingRunner([]));
		await expect(Session.create({
			model: MODEL,
			workspace: { cwd: "   " },
			createModelRunner,
		})).rejects.toMatchObject({ code: "WORKSPACE_CWD_INVALID" });
		expect(createModelRunner).not.toHaveBeenCalled();
		expect(() => resolveSessionWorkspace({ cwd: "bad\0cwd" }, process.cwd())).toThrow(WorkspaceContextError);
	});
});

describe("AGENTS.md loading and context assembly", () => {
	it("appends normalized AGENTS.md content after configured prompts", async () => {
		const cwd = await temporaryWorkspace();
		await writeFile(join(cwd, "AGENTS.md"), "\ufeffline one\r\nline two\r", "utf8");
		const runner = new RecordingRunner([async () => assistant("done")]);
		const trace = new InMemoryTraceSink();
		const session = await Session.create({
			model: MODEL,
			workspace: { cwd },
			createModelRunner: () => runner,
			contextManagerOptions: { systemPrompts: ["base one", "base two"] },
			trace: { sink: trace, sinkOwnership: "external" },
		});

		await session.agent.prompt("run");
		const context = runner.contexts[0];
		expect(context.systemPrompt).toBe(
			"base one\n\nbase two\n\n" +
			"Workspace-specific instructions loaded from AGENTS.md follow. They apply to this workspace and may refine, but must not override, earlier system instructions.\n\n" +
			"line one\nline two\n",
		);
		expect(context.systemPromptMetadata).toMatchObject({
			fragmentCount: 3,
			workspaceInstructionsLoaded: true,
		});
		expect(context.systemPromptMetadata?.workspaceInstructionsBytes).toBe(Buffer.byteLength("line one\nline two\n"));
		const contextPrepared = trace.snapshot().find((event) => event.type === "context.prepared");
		expect(contextPrepared).toMatchObject({
			systemPromptCount: 3,
			workspaceInstructionsLoaded: true,
			workspaceInstructionsBytes: context.systemPromptMetadata?.workspaceInstructionsBytes,
			workspaceInstructionsSha256: context.systemPromptMetadata?.workspaceInstructionsSha256,
		});
		expect(context.messages).toHaveLength(1);
		expect(context.messages[0]).toMatchObject({ role: "user", content: "run" });
		await session.dispose();
	});

	it("does not search parent directories for AGENTS.md", async () => {
		const root = await temporaryWorkspace("parent");
		const cwd = join(root, "child");
		await mkdir(cwd);
		await writeFile(join(root, "AGENTS.md"), "parent-marker", "utf8");
		const runner = new RecordingRunner([async () => assistant("done")]);
		const session = await Session.create({
			model: MODEL,
			workspace: { cwd },
			createModelRunner: () => runner,
		});

		await session.agent.prompt("probe");
		expect(runner.contexts[0].systemPrompt).toBe("");
		expect(runner.contexts[0].systemPromptMetadata).toMatchObject({ workspaceInstructionsLoaded: false });
		await session.dispose();
	});

	it("preserves existing behavior when AGENTS.md is missing or blank", async () => {
		const cwd = await temporaryWorkspace();
		const runner = new RecordingRunner([async () => assistant("missing"), async () => assistant("blank")]);
		const session = await Session.create({
			model: MODEL,
			workspace: { cwd },
			createModelRunner: () => runner,
			contextManagerOptions: { systemPrompts: ["base"] },
		});

		await session.agent.prompt("missing");
		await writeFile(join(cwd, "AGENTS.md"), " \r\n\t", "utf8");
		await session.agent.prompt("blank");

		expect(runner.contexts.map((context) => context.systemPrompt)).toEqual(["base", "base"]);
		expect(runner.contexts.every((context) => context.systemPromptMetadata?.workspaceInstructionsLoaded === false)).toBe(true);
		await session.dispose();
	});

	it("reloads AGENTS.md between top-level prompts", async () => {
		const cwd = await temporaryWorkspace();
		await writeFile(join(cwd, "AGENTS.md"), "marker-v1", "utf8");
		const runner = new RecordingRunner([async () => assistant("first"), async () => assistant("second")]);
		const session = await Session.create({
			model: MODEL,
			workspace: { cwd },
			createModelRunner: () => runner,
		});

		await session.agent.prompt("first");
		await writeFile(join(cwd, "AGENTS.md"), "marker-v2", "utf8");
		await session.agent.prompt("second");

		expect(runner.contexts[0].systemPrompt).toContain("marker-v1");
		expect(runner.contexts[0].systemPrompt).not.toContain("marker-v2");
		expect(runner.contexts[1].systemPrompt).toContain("marker-v2");
		expect(runner.contexts[1].systemPrompt).not.toContain("marker-v1");
		expect(runner.contexts[1].messages.some((message) => message.role === "user" && message.content === "marker-v1")).toBe(false);
		await session.dispose();
	});

	it("keeps the same system prompt through a tool loop", async () => {
		const cwd = await temporaryWorkspace();
		await writeFile(join(cwd, "AGENTS.md"), "stable-marker", "utf8");
		const runner = new RecordingRunner([
			async () => assistant("", [{ type: "toolCall", id: "call-1", name: "echo", arguments: { text: "ok" } }]),
			async () => assistant("done"),
		]);
		const session = await Session.create({
			model: MODEL,
			workspace: { cwd },
			createModelRunner: () => runner,
			configureTools(manager) {
				manager.register("echo", () => ({
					name: "echo",
					description: "echo",
					parameters: Type.Object({ text: Type.String() }),
					async execute(call) {
						return { content: String(call.arguments.text) };
					},
				}));
			},
			toolRequests: [{ name: "echo" }],
		});

		await session.agent.prompt("run tool");
		expect(runner.contexts).toHaveLength(2);
		expect(runner.contexts[1].systemPrompt).toBe(runner.contexts[0].systemPrompt);
		expect(runner.contexts[1].systemPromptMetadata).toEqual(runner.contexts[0].systemPromptMetadata);
		expect(runner.contexts[1].messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		await session.dispose();
	});

	it("fails before the model call and does not commit the prompt when the file is too large", async () => {
		const cwd = await temporaryWorkspace();
		await writeFile(join(cwd, "AGENTS.md"), "x".repeat(MAX_AGENTS_MD_BYTES + 1), "utf8");
		const runner = new RecordingRunner([async () => assistant("recovered")]);
		const session = await Session.create({
			model: MODEL,
			workspace: { cwd },
			createModelRunner: () => runner,
		});

		await expect(session.agent.prompt("must not commit")).rejects.toMatchObject({
			code: "WORKSPACE_INSTRUCTIONS_TOO_LARGE",
		});
		expect(runner.contexts).toHaveLength(0);
		expect(session.agent.state.status).toBe("idle");

		await writeFile(join(cwd, "AGENTS.md"), "fixed", "utf8");
		await session.agent.prompt("recovered prompt");
		expect(runner.contexts[0].messages).toHaveLength(1);
		expect(runner.contexts[0].messages[0]).toMatchObject({ content: "recovered prompt" });
		await session.dispose();
	});

	it("rejects a non-regular AGENTS.md and invalid UTF-8", async () => {
		const directoryCwd = await temporaryWorkspace("directory-case");
		await mkdir(join(directoryCwd, "AGENTS.md"));
		await expect(loadWorkspaceInstructions({
			workspace: resolveSessionWorkspace({ cwd: directoryCwd }, process.cwd()),
			signal: new AbortController().signal,
		})).rejects.toMatchObject({ code: "WORKSPACE_INSTRUCTIONS_NOT_REGULAR_FILE" });

		const utf8Cwd = await temporaryWorkspace("utf8-case");
		await writeFile(join(utf8Cwd, "AGENTS.md"), Buffer.from([0xc3, 0x28]));
		await expect(loadWorkspaceInstructions({
			workspace: resolveSessionWorkspace({ cwd: utf8Cwd }, process.cwd()),
			signal: new AbortController().signal,
		})).rejects.toMatchObject({ code: "WORKSPACE_INSTRUCTIONS_INVALID_UTF8" });
	});

	it("uses the effective prompt for manual compaction", async () => {
		const cwd = await temporaryWorkspace();
		let marker = "manual-v1";
		let compactSystemPrompt = "";
		const workspace = resolveSessionWorkspace({ cwd }, process.cwd());
		const loader = async (): Promise<WorkspaceInstructionFile> => ({
			content: marker,
			byteLength: 0,
			sha256: "sha256:ignored",
		});
		const manager = new DefaultContextManager({
			workspace,
			messages: [{ role: "user", content: "old", timestamp: NOW }],
			loadWorkspaceInstructions: loader,
			compactor(input) {
				compactSystemPrompt = input.systemPrompt;
				return { messages: [{ role: "user", content: "summary", timestamp: NOW }] };
			},
		});

		marker = "manual-v2";
		await manager.compactCurrent({ signal: new AbortController().signal });
		expect(compactSystemPrompt).toContain("manual-v2");
		expect(compactSystemPrompt).not.toContain("manual-v1");
		expect(manager.snapshot().messages).toEqual([{ role: "user", content: "summary", timestamp: NOW }]);
	});
});
