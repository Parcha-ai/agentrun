---
packages: @parcha/agentrun-serve
kind: fix
---
A run created with `hold: true` is no longer refused at its create when only its model blocks it: no key here for the model, its harness refusing it, or no price for it under a `max_cost_usd` cap. The run opens and holds its computer, so a benchmark that only sets a task up, calls the computer and releases it works on a server with no model key. The model check now runs at the start instead: `POST /runs/{run_id}/start`, and any message to the run, answer `409 agent_not_runnable` with the same message, fields and details the create would have given, and the computer still takes calls until it is released or its hold lapses. A key saved after the create does not unblock that run; start a new one. Any other blocker (a tool's missing key, the computer, the box) still refuses a held create as before.
