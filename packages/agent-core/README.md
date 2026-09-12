# @ailoha/agent-core

Minimal Agent Core based on the Pi `Model`, `Message`, `ToolCall`, content, and
TypeBox schema types. Provider execution stays behind the injected `ModelRunner`.

Included now:

- one active run per Agent;
- one-to-one Session composition root that constructs and owns one Agent;
- one Session Runtime that owns multiple isolated Sessions;
- concurrent runs across different Sessions;
- ReAct loop plus follow-up loop;
- steer and follow-up admission phases;
- Agent-lifetime tool instances with serial per-run execution;
- preventative and recovery compact points;
- cancellation closure for pending tool calls;
- in-memory `DefaultContextManager` and read-only snapshots.

Persistence, restart recovery, hooks, and multi-agent routing are deliberately
not included in this MVP.

Create a Session asynchronously so all tools are initialized before its Agent is exposed:

```ts
const session = await Session.create({
	model,
	createModelRunner: () => modelRunner,
	configureTools(manager) {
		manager.register("calculator", () => createCalculatorTool());
	},
	toolRequests: [{ name: "calculator" }],
});

await session.agent.prompt("Calculate 6 * 7");
await session.dispose();
```

Run independent Sessions concurrently and release them as one Runtime:

```ts
const runtime = new SessionRuntime();
const [alice, bob] = await Promise.all([
	runtime.createSession({ id: "alice", session: aliceOptions }),
	runtime.createSession({ id: "bob", session: bobOptions }),
]);

const [aliceResult, bobResult] = await Promise.all([
	alice.agent.prompt("Alice's task"),
	bob.agent.prompt("Bob's task"),
]);

await runtime.dispose();
```

Each managed Session gets its own Agent, ContextManager, ToolManager, Tool
instances, queues, and cancellation signals. A single Session still rejects a
second concurrent top-level prompt.
