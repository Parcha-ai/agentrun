---
packages: @parcha/agentrun-serve, @parcha/agentrun-dsl
kind: feature
---
A learned workflow's replay records an escalate that reads a judge's field instead of obeying it, and its refit may switch that escalate, or any guard, off. A replay that hands back every input is held: it would never answer alone.
- In a replay, an `escalate` node whose `when` reads a field of a `judge` node's output (`not` included) no longer stops the run: the workflow goes on to its answer, and the run's guard rows carry the escalate (`signal: "escalate"`, `p` 0 when it fired) so the replay scores it as a hand-back where it fired. Every other escalate stays hard in a replay, and serving obeys every escalate.
- The refit keeps its rule (the cheapest setting within 2 points of the agent) and now has "off" among its settings: an escalate or a guard that stops right drafts is dropped from the new revision, one that stops wrong drafts stays. It runs when a recorded escalate is the workflow's only switch. The refit record's `guards` say what changed: `{node, was, threshold: null}` for a guard switched off, `{node, was: null, threshold: null, escalate: true}` for an escalate.
- A replay or refit that handed back every one of its inputs is held, with the reason "it handed back every one of its N replayed inputs: it would never answer alone". A promotion record's `replay` carries `alone` (inputs answered alone), and the console shows it ("replayed 20/20 · 9 alone").
- DSL: `WorkflowDeps.softEscalate(label)` makes the named escalate record its `escalate.evaluated` event (`soft: true`) and go on instead of handing back; a child workflow's escalate is asked by its `parent/child` label.

Upgrading: a promotion record's `replay.alone` is required, and a refit guard's `was` and `threshold` may be null; a client reading `/agents/{agent_id}/learning/promotions` reads both.
