---
packages: @parcha/agentrun-serve
kind: feature
---
Launch hook: with `AGENTRUN_LAUNCH_HOOK_URL` and `AGENTRUN_LAUNCH_HOOK_SECRET` set, each trigger firing that would start a run is POSTed to the host instead, signed as Standard Webhooks (`{firing_id, trigger_id, agent_id, revision_id, input, fired_at}`), and the host starts the run through the API with its own keys and cap. The host passes the new `trigger_firing` (`{trigger_id, firing_id}`) on `POST /agents/{agent_id}/runs`, so the run is the firing's: it carries the trigger, its title and input origin, and the firing reads `started` with it, counted by the overlap check and `max_active_runs`. A 2xx without such a run records the firing `sent`; any other answer, or none in 10 s, records it `skipped` with why. Unset, firings start their runs as before, and `trigger_firing` is refused.
