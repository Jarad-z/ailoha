import { Type } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { Agent, AgentStateError, DefaultContextManager, ToolManager } from "../src/index.js";
import type { AgentModel, AgentTool, ModelRunner } from "../src/index.js";

const MODEL: AgentModel = {
	id: "tool-lifecycle-model",
	name: "Tool Lifecycle Model",
	api: "test-api",
	provider: "test-provider",
	baseUrl: "https://invalid.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_000,
};
const RUNNER: ModelRunner = {
	async run() {
		throw new Error("not used");
	},
};

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function tool(name: string, dispose?: () => void | Promise<void>): AgentTool {
	return {
		name,
		description: name,
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute() {
			return { content: name };
		},
		dispose,
	};
}

async function initialize(manager: ToolManager, names: readonly string[]): Promise<void> {
	await manager.initialize(
		names.map((name) => ({ name })),
		{ sessionId: "tool-manager-test-session", model: MODEL, signal: new AbortController().signal },
	);
}

describe("ToolManager lifecycle", () => {
	it("starts configuring and exposes tools only after initialization", async () => {
		const manager = new ToolManager();
		expect(manager.status).toBe("configuring");
		expect(() => manager.tools).toThrow(AgentStateError);

		manager.register("one", () => tool("one"));
		await initialize(manager, ["one"]);

		expect(manager.status).toBe("ready");
		expect(manager.tools.map((candidate) => candidate.name)).toEqual(["one"]);
		expect(Object.isFrozen(manager.tools)).toBe(true);
	});

	it("calls each requested factory once and keeps one tools array", async () => {
		const manager = new ToolManager();
		const factory = vi.fn(() => tool("one"));
		manager.register("one", factory);
		await initialize(manager, ["one"]);
		const firstRead = manager.tools;

		expect(manager.tools).toBe(firstRead);
		expect(factory).toHaveBeenCalledTimes(1);
	});

	it("rejects duplicate requests without calling a factory twice", async () => {
		const manager = new ToolManager();
		const factory = vi.fn(() => tool("one"));
		manager.register("one", factory);

		await expect(initialize(manager, ["one", "one"])).rejects.toThrow("Duplicate tool request: one");
		expect(factory).toHaveBeenCalledTimes(1);
		expect(manager.status).toBe("disposed");
	});

	it("rejects Agent construction with an uninitialized ToolManager", () => {
		expect(
			() =>
				new Agent({
					sessionId: "tool-manager-test-session",
					model: MODEL,
					modelRunner: RUNNER,
					contextManager: new DefaultContextManager(),
					toolManager: new ToolManager(),
				}),
		).toThrow("Agent requires an initialized ToolManager.");
	});

	it("rejects register after ready and a second initialize", async () => {
		const manager = new ToolManager();
		manager.register("one", () => tool("one"));
		await initialize(manager, ["one"]);

		expect(() => manager.register("two", () => tool("two"))).toThrow(AgentStateError);
		await expect(initialize(manager, ["one"])).rejects.toThrow(AgentStateError);
	});

	it("cleans up initialized tools in reverse order when a later factory fails", async () => {
		const manager = new ToolManager();
		const disposed: string[] = [];
		manager.register("one", () =>
			tool("one", () => {
				disposed.push("one");
			}),
		);
		manager.register("two", () =>
			tool("two", () => {
				disposed.push("two");
			}),
		);
		manager.register("three", () => {
			throw new Error("three failed");
		});

		await expect(initialize(manager, ["one", "two", "three"])).rejects.toThrow("three failed");
		expect(disposed).toEqual(["two", "one"]);
		expect(manager.status).toBe("disposed");
		expect(() => manager.tools).toThrow(AgentStateError);
	});

	it("preserves initialization failure when cleanup also fails", async () => {
		const manager = new ToolManager();
		manager.register("one", () =>
			tool("one", () => {
				throw new Error("cleanup failed");
			}),
		);
		manager.register("two", () => {
			throw new Error("initialize failed");
		});

		const failure = initialize(manager, ["one", "two"]).catch((error: unknown) => error);
		const error = await failure;
		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).errors).toMatchObject([
			{ message: "initialize failed" },
			{ message: "cleanup failed" },
		]);
		expect((error as AggregateError).cause).toMatchObject({ message: "initialize failed" });
	});

	it("disposes a tool returned after its lifetime signal was aborted", async () => {
		const manager = new ToolManager();
		const controller = new AbortController();
		const pending = deferred<AgentTool>();
		const dispose = vi.fn();
		manager.register("one", async () => await pending.promise);
		const initializing = manager.initialize(
			[{ name: "one" }],
			{ sessionId: "tool-manager-test-session", model: MODEL, signal: controller.signal },
		);

		controller.abort();
		pending.resolve(tool("one", dispose));
		await expect(initializing).rejects.toMatchObject({ name: "AbortError" });
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(manager.status).toBe("disposed");
	});

	it("disposes every tool in reverse order and reports all failures", async () => {
		const manager = new ToolManager();
		const disposed: string[] = [];
		manager.register("one", () =>
			tool("one", () => {
				disposed.push("one");
			}),
		);
		manager.register("two", () =>
			tool("two", () => {
				disposed.push("two");
				throw new Error("two dispose failed");
			}),
		);
		manager.register("three", () =>
			tool("three", () => {
				disposed.push("three");
			}),
		);
		await initialize(manager, ["one", "two", "three"]);

		await expect(manager.dispose()).rejects.toMatchObject({
			name: "AggregateError",
			errors: [{ message: "two dispose failed" }],
		});
		expect(disposed).toEqual(["three", "two", "one"]);
		expect(manager.status).toBe("disposed");
		expect(() => manager.tools).toThrow(AgentStateError);
	});

	it("dispose is idempotent and invokes each tool disposer once", async () => {
		const manager = new ToolManager();
		const dispose = vi.fn();
		manager.register("one", () => tool("one", dispose));
		await initialize(manager, ["one"]);

		await manager.dispose();
		await manager.dispose();
		expect(dispose).toHaveBeenCalledTimes(1);
	});
});
