---
packages: @parcha/agentrun-serve
kind: feature
---
A run can bring its own tool keys: `keys: {"PARALLEL_API_KEY": "..."}` on `POST /v2/runs`, `POST /v2/agents/{agent_id}/runs` and a message, for the tool keys its revision reads (422 at `keys.<NAME>` otherwise).
Each one is sealed with the run's launch, opened at its claim for its tools alone and erased from the store when its turn ends; the runner's redactor keeps the value in memory to cut it. It is never in the run's body, timeline, view or logs, and the runner cuts it from what the run writes.
`AGENTRUN_RUN_KEYS=1`: a template's apply makes its agent though a tool key it declares is not set here, with a warning, and each run of that agent must bring the key in `keys` (409 `agent_not_runnable` at `keys.<NAME>` without it). Keys the server holds are still used by runs that bring none. The monid key stays the server's: an agent's monid tools are checked with it when the agent is saved, so with none on the server a template granting them is still refused at its apply.
