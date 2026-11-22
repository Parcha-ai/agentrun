---
packages: @parcha/agentrun-serve
kind: fix
---
Launch hook: a run the host starts for a handed firing (`trigger_firing`) now starts on the trigger's target, as a run the server starts for it does. Before, it took the host's `max_cost_usd` or the agent's default cap, so a schedule capped at $0.50 on an agent with a $5 default ran at $5, and it dropped the target's effort and the trigger's last result.

The cap is the target's, which the host's `max_cost_usd` may lower and never raise. The effort is the target's when it sets one, else the host's. The input is followed by the trigger's last result, as on a run the server starts. The rest of the host's body is taken as on any start, its `model_key`, `keys` and `mcp_auth` among it.

The failure's message names the status, the timeout or the connection error, never the hook's URL, which can carry a query token.

A hook that does not take a firing is now a failed try under the trigger's retry policy, not a skip. The firing's error is `hook_failed`, and its reason names the status, `timeout` or `unreachable`. No answer, no connection, a 5xx or a 429 is tried again on the trigger's backoff; any other answer fails the firing. Each counts toward the failure streak, auto-pause and `trigger.failed`.

A host start that lands after the hook's 10 s while its firing waits on a retry makes the firing `started` with that run, so the overlap check, `max_active_runs` and `last_run_id` count it.
