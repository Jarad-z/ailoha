# @ailoha/agent-tools

Built-in tools for `@ailoha/agent-core`:

- `calculator`: safe arithmetic expression parser;
- `search`: injectable search provider with deterministic in-memory mock;
- `read_docs`: UTF-8 document reader restricted to configured roots;
- `todo`: Agent-lifetime in-memory todo list;
- `weather`: injectable weather provider with deterministic mock data.

Register all tools:

```ts
import { registerAgentTools } from "@ailoha/agent-tools";

registerAgentTools(toolManager, {
	readDocs: { roots: ["./docs"] },
	search: { documents: [{ id: "intro", title: "Intro", content: "..." }] },
});
```

Agent Core initializes tools once in `Session.create()`, so the default todo store
is shared by every top-level prompt handled by that Session's Agent. It is released
with the other tools by `Session.dispose()`. Persistence can later replace it with
a custom store without changing Agent Core.
