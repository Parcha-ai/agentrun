# @parcha/agentrun-adapters

Agent harnesses other than Pi behind one seam, starting with Codex, so a DSL `agent` node and an AgentRun run can run on a
harness adapter the way they run on Pi, durable in AgentRun's own store. It is held: not on npm yet.

- `createHarnessRunner(adapter, options)` is exactly the interpreter's `runNode`. A node's record arrives through an
  injected `submit` tool whose input is the node's schema under `value` (`submitParameters` from
  `@parcha/agentrun-dsl`, the envelope the Pi runner uses too); a review that does not accept it is answered in the same
  session. Every paid request passes the runner first: the turn cap, then the host's `beforeRequest`, which receives the
  node's `budget_usd` and what its session has spent, and may refuse it. Under `withRecovery` a session is keyed by its
  step's `sessionId`: a delivered record is answered from the session's records with nothing run, and a session a
  process died inside resumes from its records with nothing paid twice. Without a step each call is a fresh session.
- `AgentAdapter` is the interface a harness implements: `check` refuses a session before anything is spent (a fork it
  cannot make), and `open` restores a session from its records.
- `./testing` has `memorySessionStore` and `fauxAdapter`, a scripted harness with no model and no network.

The runner's own bounds (a turn limit, an unknown tool, a refused fork, the host's refusal) fail a node with
`final: true`, so a recovery driver gives it no second attempt. It imports no host: serve and any DSL host use it alike.

Code this package copies from another project is listed in `vendor/durable-harness/UPSTREAM.json` and credited in
`NOTICE`.
