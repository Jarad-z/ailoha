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
- exclusive idle-time manual context compaction;
- an optional ContextManager-lifetime model turn limit;
- structured run/tool execution Trace events;
- in-memory, JSONL, console, and subscription Hub Trace sinks;
- cancellation closure for pending tool calls;
- in-memory `DefaultContextManager` and read-only snapshots.

Persistence, restart recovery, hooks, and multi-agent routing are deliberately
not included in this MVP.

Set `contextManagerOptions.maxTurns` to a non-negative integer to cap model
calls for the lifetime of that ContextManager. Failed calls and compact recovery
retries also consume turns. Once exhausted, prompt, steer, and follow-up
admission is rejected and no further model call can start. The default is
`Infinity`.

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

// Manual compaction is an exclusive maintenance operation. It does not create
// a Run or reset maxTurns/turnCount, and is a no-op without a configured compactor.
const compacted = await session.agent.compact();
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

Subscribe to live Tool execution events while persisting the same event stream:

```ts
const jsonl = new JsonlTraceSink({ path: "./logs/trace.jsonl" });
const traceHub = new TraceEventHub({ sinks: [jsonl] });
const subscription = traceHub.subscribe({
	filter: {
		eventTypes: ["tool.call.started", "tool.call.finished"],
	},
});

const session = await Session.create({
	model,
	createModelRunner: () => modelRunner,
	trace: {
		sink: traceHub,
		sinkOwnership: "external",
	},
});

const consuming = (async () => {
	for await (const delivery of subscription) {
		if (delivery.kind === "event") console.log(delivery.cursor, delivery.event);
	}
})();

await session.agent.prompt("Run the task", {
	runId: "run-from-service-layer",
	correlationId: "operation-123",
});
subscription.close();
await consuming;
await session.dispose();
await traceHub.dispose();
```

Each managed Session gets its own Agent, ContextManager, ToolManager, Tool
instances, queues, and cancellation signals. A single Session still rejects a
second concurrent top-level prompt.
