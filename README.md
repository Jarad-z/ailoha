# Ailoha

Packages:

- `@ailoha/agent-core`: provider-independent Agent, Session Runtime, tools, context, manual compaction, and Trace primitives.
- `@ailoha/agent-service`: product-facing Session/Run/Operation/Transcript runtime plus a Node HTTP/SSE adapter.
- `@ailoha/agent-tools`: built-in Tool implementations.

Independent monorepo for the Ailoha agent runtime. The repository consumes the
published `@earendil-works/pi-ai` package; it does not add agent code to the Pi
source repository.

Current scope: `packages/agent-core`, including isolated multi-Session runtime
management, and the reusable tools in `packages/agent-tools`.

```sh
npm install --ignore-scripts
npm run check
npm run test:core
```

Run the deterministic end-to-end suite. It uses the real Session, Context,
built-in tools, and Trace pipeline with only the model boundary scripted:

```sh
npm run test:e2e
```

Run the real-model HTTP black-box E2E. This builds the workspaces, starts the
Agent Service on an ephemeral localhost port, calls DeepSeek, verifies the
calculator Trace, checks the final transcript, and shuts the server down:

```sh
npm run test:e2e:live
```

The scenario matrix, product-specific assertions, and known gaps are documented
in [`minimal-agent-e2e-test-plan.md`](./minimal-agent-e2e-test-plan.md).

Run the real DeepSeek two-Session concurrency and isolation smoke test with
`DEEPSEEK_API_KEY` set in the environment or an ignored `.env.local` file:

```sh
npm run demo:deepseek:runtime
```
