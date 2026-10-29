---
packages: @parcha/agentrun-serve
kind: feature
---
AgentRun Server runs decision workflows on Jev. A workflow's typed questions (its `judge`, `pick`, `sift`, `route` and `ask` nodes) run on TypeSafe's System One through `@parcha/agentrun-jev` when the server's environment sets `TYPESAFE_API_KEY` (or `OPENROUTER_API_KEY`, for Jev through OpenRouter). Until now, such a workflow was refused at save.
- Each question's receipt is a row of the run's store before its answer acts. Jev reports no cost, so a receipt keeps its cost unknown, and so does the run: its `cost.usd` reads `null`, never `0`, while a decision's cost is unknown. An ended run the store kept no cost for now reads unknown too.
- With no key, such a workflow saves with a `not_set_up_here` warning naming the variable. A run of it is `409 agent_not_runnable` with `details.adapters: ["runJudge"]` and `details.decisions: {jev: {reason: "not_set_up_here", needs: ["TYPESAFE_API_KEY"]}}`.
- `GET /capabilities` lists the decision providers in `workflows.decisions.providers` (`[{id: "jev", available, reason?}]`), marked as the server's own in `/v2/openapi.json`. `runJudge` is among `workflows.adapters` once Jev runs.
- The TypeSafe key never enters a run's environment, which its tools and its model's provider read. The server drops `TYPESAFE_API_KEY` from every run's process and hands its value to a workflow run's process once, on an inherited pipe, for the judge's runner alone.
