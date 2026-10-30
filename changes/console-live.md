---
packages: repo
kind: feature
---
The console reads a live AgentRun Server: the runs, and a run followed from its timeline cursor (long poll), with stop, cancel and messages sent as same-origin JSON with an `Idempotency-Key`. `npm run dev` in `apps/console` proxies `/v2` to a local server (`AGENTRUN_URL`, `AGENTRUN_TOKEN`).
