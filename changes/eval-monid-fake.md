---
packages: @parcha/agentrun-serve
kind: feature
---
A template eval case can take monid down: `monid: unavailable` in its `case.yaml` answers every call of the package's monid endpoints as monid unreachable does (`<endpoint> was not sent: monid's price for it could not be read before the call (monid could not be reached: fetch failed).`), through the runner's own monid path with a fetch that never connects. No call is sent, nothing is held or charged, and the calls show in the timeline under their monid names, so `tool_used` counts them. It holds on pi, claude-agent and codex, wherever the run's monid endpoints are bound.
- Only the eval's own in-process runner honours it, by the agent it made for the run: no package field, API field, setting or environment variable turns it on, and a case with `monid` refuses `--server`. The package must grant a monid endpoint.
- The apply still pins the endpoints from monid's listing (a free read, no run), so the agent's tools are the ones it has live.
