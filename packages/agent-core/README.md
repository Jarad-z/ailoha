# @ailoha/agent-core

Minimal Agent Core based on the Pi `Model`, `Message`, `ToolCall`, content, and
TypeBox schema types. Provider execution stays behind the injected `ModelRunner`.

Included now:

- one active run per Agent;
- ReAct loop plus follow-up loop;
- steer and follow-up admission phases;
- per-run tool factories and serial tool execution;
- preventative and recovery compact points;
- cancellation closure for pending tool calls;
- in-memory `DefaultContextManager` and read-only snapshots.

Persistence, restart recovery, multiple sessions, hooks, and multi-agent routing
are deliberately not included in this MVP.
