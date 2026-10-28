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
  A call's `tool_end` reaches `onEvent` only once its outcome is in the session's records, with the text recorded as
  `result`, so a host never shows a result its store does not hold.
- `runner.stop({ drainMs })` pauses every node the runner is running: no new turn, tool call or paid request starts, the
  calls in flight run on until their outcomes are recorded (for at most `drainMs`, on an adapter that drains; the Claude
  Agent adapter does), and then the node fails `aborted`. Run again with the same step, it resumes from its records: a
  call that finished during the pause is never run, or paid for, again.
- `AgentAdapter` is the interface a harness implements: `check` refuses a session before anything is spent (a fork it
  cannot make), and `open` restores a session from its records.
- `SessionStore` is the run's store for sessions. A session is written only through a writer, and `open(key)` takes the
  session: every writer opened earlier for that key is fenced from then on, and its appends are refused
  (`SessionFenced`) with nothing written. The runner opens one writer per attempt and hands it to the adapter, so a
  process whose lease lapsed while it was still alive cannot act in a session a newer process holds; it ends `fenced`.
- `./testing` has `memorySessionStore` and `fauxAdapter`, a scripted harness with no model and no network.
- `./kernel` is the durable kernel an adapter runs on (`openDrive` over the session's writer): an effect's intent, then
  at most one outcome; after a crash a `safe` effect runs again and a `never` one is reported interrupted, never run
  again. So a tool that costs money per call (a paid search) is `never`: `safe` means free to run again. A drive whose writer was fenced gets a `Restart` at its next write, so it never runs a new effect.
  `./process` is the shared layer for harnesses that run as a child process: the native journal, the transcript, the
  recovery note, the tool bridge, the built-ins' hook-pair calls, the inbox (and `waitForSubmissions`, for a harness that
  waits for input while a turn runs), and `zodShapeFromJsonSchema`, for harness SDKs whose tool APIs take zod.
- `./host` is the session's model proxy, provider-neutral: on the loopback interface, it admits only the session's key,
  only the routes a `ProviderPolicy` lists (by exact path text, with no query or one the route lists exactly; a route
  may also be answered by the proxy, or be free, like a token count), and strict JSON, has the policy shape or refuse the
  body, asks the runner's `beforeRequest` before each paid request, adds the provider's credential (which never reaches
  the harness), and reports each response's usage to `afterRequest`. Model spend is accounted only there, by the runner.

The runner's own bounds (a turn limit, no progress, an unknown tool, a refused fork, the host's refusal) fail a node
with `final: true`, so a recovery driver gives it no second attempt. Turns sent to a node are bounded by its turn limit,
or by `maxSends` (default 100) when the limit is null, and three turns in a row that make no paid request and deliver
nothing end it `no_progress`: a harness that never reaches its model is stopped, not sent turns forever. It imports no host: serve and any DSL host use it alike.

Code this package copies from another project is listed in `vendor/durable-harness/UPSTREAM.json` and credited in
`NOTICE`.
