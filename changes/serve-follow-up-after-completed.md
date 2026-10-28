---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: fix
---
**A completed run takes a follow-up, as the contract says**
- `POST /runs/{id}/messages` to a completed agentic run is a `follow_up`: the run opens again on its own store and session, under its spend cap, answers, and completes again. It used to be `409 not_continuable`. It is the same run, before and after a server restart.
- Opening it takes a place under `--max-runs`: with none free the message is `429 rate_limited`, and the run stays completed.
- A failed or cancelled run, an archived run and a run of an archived agent stay `409 not_continuable`: archiving closes a run.
- The agent store has `reopenRun`, which opens a completed run again (running, no end); its cost and summary stay until the next `carryBack`.
