# Ailoha

Independent monorepo for the Ailoha agent runtime. The repository consumes the
published `@earendil-works/pi-ai` package; it does not add agent code to the Pi
source repository.

Current scope: `packages/agent-core`, the single-run MVP from
`pi/agent-core-minimal-spec.md`.

```sh
npm install --ignore-scripts
npm run check
npm run test:core
```
