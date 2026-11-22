---
packages: @parcha/agentrun-serve
kind: feature
---
Launch hook: with `AGENTRUN_LAUNCH_HOOK_URL` and `AGENTRUN_LAUNCH_HOOK_SECRET` set, each trigger firing that would start a run is POSTed to the host instead, signed as Standard Webhooks (`{firing_id, trigger_id, agent_id, revision_id, input, fired_at}`), and the host starts the run through the API with its own keys.

The host passes the new `trigger_firing` (`{trigger_id, firing_id}`) on `POST /agents/{agent_id}/runs`, so the run is the firing's. It carries the trigger, its title and input origin, and the firing reads `started` with it, counted by the overlap check and `max_active_runs`.

The run starts on the trigger's target. Its cap is the target's `max_cost_usd`, which the host's `max_cost_usd` may lower and never raise; a target with no cap takes the host's, else the agent's default. Its effort is the target's, and its input is the host's, followed by the trigger's last result when its source hands one on (a schedule does).

The host may start the run before or after it answers. A 2xx without the run records the firing `sent` with `start_by`, 10 minutes after that answer, and it takes that one start until then. The 10 minutes run from the answer, not from `fired_at`, so a catch-up, a firing that waited on `max_active_runs` or one handed again after a restart gets the same time.

Any other answer, or none in 10 s, is a failed try of the firing (`hook_failed`, with the status, `timeout` or `unreachable`) under the trigger's retry policy: no answer, no connection, a 5xx or a 429 is tried again on its backoff, any other answer fails it, and each counts toward the failure streak and `trigger.failed`.

The hook URL is https, or http to 127.0.0.0/8, `::1` or `localhost` alone; any other http URL stops the start. On an API-only server (`AGENTRUN_API_ONLY=1`), the hook is what lets a template's apply make its schedule and feed triggers. Unset, firings start their runs as before, and `trigger_firing` is refused.
