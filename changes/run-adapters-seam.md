---
packages: @parcha/agentrun-adapters
kind: feature
---
New package `@parcha/agentrun-adapters`, held (not on npm yet): the seam for agent harnesses other than Pi. `createHarnessRunner(adapter, options)` is exactly the interpreter's `runNode`, so a DSL `agent` node runs on any harness that implements `AgentAdapter`, the way `createPiRunner` runs it on Pi.
- The node's record arrives through an injected `submit` tool (the node's schema under `value`); a review that does not accept it is answered in the same session.
- Every paid request passes the runner first: the turn cap (`maxTurns`, default 8, and a node's own `max_turns` within it), then the host's `beforeRequest`, which receives the node's `budget_usd`, what its session has spent, its label, key and execution path, and may refuse the request. `maxSubmissions` (default 5) and `timeoutMs` (default 120 s) are the Pi runner's.
- Under `withRecovery` a session is keyed by its step's `sessionId`: a delivered record is answered from the session's records with nothing run, and a session a process died inside is resumed with nothing paid twice. Without a step each call opens a fresh session.
- Turns sent to a node have their own count, against its turn limit (or `maxSends`, default 100, when the limit is null); turns that end with no paid request and no accepted submission end the node `no_progress` after three in a row. Turns, spend and `max_turns` still count paid requests only.
- A turn limit, no progress, an unknown tool, a fork the harness cannot make and a host refusal fail the node with `final: true`.
- Every event names its node (session key, label, execution path).
- `./testing` has `memorySessionStore` and `fauxAdapter`, a scripted harness with no model and no network.
