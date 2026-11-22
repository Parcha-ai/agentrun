---
packages: @parcha/agentrun-serve
kind: feature
---
Launch hook: with `AGENTRUN_LAUNCH_HOOK_URL` and `AGENTRUN_LAUNCH_HOOK_SECRET` set, each trigger firing that would start a run is POSTed to the host instead, signed as Standard Webhooks (`{firing_id, trigger_id, agent_id, revision_id, input, fired_at}`), and the host starts the run through the API with its own keys and cap. A 2xx answer records the firing `sent`, with the run the host names; any other answer, or none in 10 s, records it `skipped` with why. Unset, firings start their runs as before.
