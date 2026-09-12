# Ailoha

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

Run the real DeepSeek two-Session concurrency and isolation smoke test with
`DEEPSEEK_API_KEY` set in the environment or an ignored `.env.local` file:

```sh
npm run demo:deepseek:runtime
```
