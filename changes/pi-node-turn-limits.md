---
packages: @parcha/agentrun-dsl, @parcha/agentrun-pi
kind: feature
---
A Pi node's turn limit can be seen and raised. A first-run tester's read-only research node failed three times at the fixed 8 turns, with no way to raise it and no word of how far it got.
- An `agent` node may carry `max_turns`, a positive integer: the most turns it asks its host for, per attempt. The engine checks its shape and hands it to `runNode` as `maxTurns`; it enforces nothing, and naming it changes the workflow's digest.
- In the Pi extension, `runtimeLimits.nodeMaxTurns` keeps its meaning (the most turns any node gets; a host lowers it or sets `null`) and is the cap on a node's `max_turns`; its default goes from 8 to 40. A node that names no `max_turns` gets 20 turns when it can only read (no `bash`, `edit` or `write`, and no host tools), and 8 otherwise. Inspection refuses a node that asks for more than the cap, naming it. `describe` reports the two defaults as `nodeTurnDefaults`.
- A node that reaches its turn limit is not tried again: `PiRunError` for a turn limit is `final`, so the recovery driver gives it no second attempt. Before, each failure ran a second fresh session with the same prompt and limit; the tester's three runs spent 2 sessions of 8 turns each, and the second never helped.
- `pi_turn_limit` says how many turns the node used of its limit and its last tool call, and how to raise `max_turns`. `PiRunError` carries `maxTurns` and `lastTool` (the tool's name, never its arguments).
- `/agentrun limits` shows the limits in force, and the turn limit of each node that runs in a Pi session (agent, decide, extract, report) in the current workflow and where it comes from.
