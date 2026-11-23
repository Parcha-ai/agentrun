---
packages: @parcha/agentrun-serve
kind: fix
---
Launch hook: a run the host starts for a handed firing (`trigger_firing`) now starts on the trigger's target, as a run the server starts for it does. In 0.1.0-beta.53 it ran at the host's `max_cost_usd` or the agent's default, so a schedule capped at $0.50 on an agent with a $5 default ran at $5, and it dropped the target's effort and the trigger's last result.

- Its cap is the lower of the target's `max_cost_usd` and the host's: the host may lower it, never raise it. A target with no cap takes the agent's default in its place, so a host's $500 on an agent with a $2 default runs at $2, as the trigger's own run would.
- Its effort is the target's when the target sets one, else the host's.
- Its input is followed by the trigger's last result when its source hands one on (a schedule does), as on a run the server starts.
- The rest of the host's body is taken as on any start: its `model_key`, `keys` and `mcp_auth` are sealed for the run.

A hook that does not take a firing is now a failed try under the trigger's retry policy, no longer `skipped`. The firing's error is `hook_failed`, and its reason names the status, `timeout` or the connection's error code, never the hook's URL, which can carry a query token. No answer, no connection, a 5xx or a 429 keeps the firing `due` with `retry_at`, to be handed again on the trigger's backoff; any other answer, a redirect included, fails it, and the failed firing sends `trigger.failed`.

A firing now counts once toward its trigger's failure streak, when it fails, however many tries it took. In 0.1.0-beta.53 each try counted, so one firing tried again on a busy server could turn its trigger off by itself.

A host start that lands while its firing waits on a retry makes the firing `started` with that run, so the overlap check, `max_active_runs` and `last_run_id` count it, while its trigger has room for it: a firing whose place another firing's run has taken since is refused with 422 `not_due`. One that lands just as the server records the hook's answer leaves the firing `started` with its run: the answer no longer sets it back to `sent`, fails it or counts a failure.
