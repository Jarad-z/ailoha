# @ailoha/agent-service

Single-process application service for `@ailoha/agent-core`. It turns server-owned Agent Profiles into isolated chat Sessions and exposes stable Run, Operation, Transcript, Service Event, and Trace APIs.

The package contains no provider credentials and does not accept executable Tool factories from clients. The host supplies a `resolveSessionOptions` allowlist resolver.

```ts
import { AgentServiceRuntime, createAgentServiceHttpServer, loadAgentServiceTraceConfig } from "@ailoha/agent-service";

const runtime = new AgentServiceRuntime({
	traceConfig: loadAgentServiceTraceConfig(),
	resolveSessionOptions(profile) {
		const model = allowedModels.get(profile.modelId);
		if (!model) throw new Error("Model is not allowlisted.");
		return {
			model,
			createModelRunner: () => createRunner(model),
			contextManagerOptions: {
				systemPrompts: profile.systemPrompts,
				maxTurns: profile.maxTurns,
			},
			toolRequests: profile.tools,
			configureTools: registerAllowedTools,
		};
	},
});

const server = createAgentServiceHttpServer(runtime, {
	authenticate(request) {
		return { ownerId: verifyBearerToken(request.headers.authorization) };
	},
});

server.listen(3000);
```

Write endpoints require `Idempotency-Key`. The in-memory v0.1 loses Sessions, Context, Operations, Transcript, event cursors, and idempotency records on process restart.

HTTP endpoints:

- `/v1/agent-profiles`
- `/v1/sessions` and `/v1/sessions/{id}`
- `/v1/sessions/{id}/messages`
- `/v1/sessions/{id}/compact`
- `/v1/sessions/{id}/events` (SSE)
- `/v1/sessions/{id}/trace` (SSE)
- `/v1/runs/{id}`, `/abort`, `/steer`, and `/follow-ups`
- `/v1/runs/{id}/trace` (completed Run, `application/x-ndjson`)
- `/v1/operations/{id}`

Call `runtime.dispose()` during shutdown. This stops new admission, closes event subscribers, aborts/awaits active Runs or manual compaction, disposes Tools, and closes the owned Trace Hub.
