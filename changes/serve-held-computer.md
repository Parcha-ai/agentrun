---
packages: @parcha/agentrun-serve, @parcha/agentrun-client, @parcha/agentrun
kind: feature
---
A run can hold its computer for its owner: `hold: true` on POST /agents/{agent_id}/runs claims the run's sandbox, desktop or phone and waits, the agent not started, until POST /runs/{run_id}/start; after the agent ends, the run keeps the computer until POST /runs/{run_id}/computer/release, or until `hold_minutes` (default 30, at most 120) pass with no call from the owner.
Meanwhile POST /runs/{run_id}/computer/call `{ method, params }` sends the computer one protocol call and answers what it answered, verbatim; a method outside the computer protocol is refused. The routes take the owner's token or session, never a run's. GET /runs/{run_id} says where the hold is in `computer.held`, and the Timeline says each change. A benchmark sets a task up, starts the agent, checks the computer after, then lets it go.
