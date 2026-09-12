# @ailoha/agent-tools

Built-in tools for `@ailoha/agent-core`:

- `calculator`: safe arithmetic expression parser;
- `search`: injectable search provider with deterministic in-memory mock;
- `read_docs`: UTF-8 document reader restricted to configured roots;
- `todo`: run-local in-memory todo list;
- `weather`: injectable weather provider with deterministic mock data.

Register all tools:

```ts
import { registerAgentTools } from "@ailoha/agent-tools";

registerAgentTools(toolManager, {
	readDocs: { roots: ["./docs"] },
	search: { documents: [{ id: "intro", title: "Intro", content: "..." }] },
});
```

Because Agent Core instantiates tools once per top-level prompt, the default todo
store is isolated to one run. Persistence can later replace it with a custom
store without changing Agent Core.
