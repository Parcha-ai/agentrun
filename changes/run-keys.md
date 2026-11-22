---
packages: @parcha/agentrun-serve
kind: feature
---
A run can bring its own tool keys: `keys: {"PARALLEL_API_KEY": "..."}` on `POST /v2/runs`, `POST /v2/agents/{agent_id}/runs` and a message, for the tool keys its revision reads (422 at `keys.<NAME>` otherwise). Each one is sealed with the run's launch, opened at its claim for its tools alone and erased when its turn ends; it is never in the run's body, timeline, view or logs, and the runner cuts it from what the run writes.
`AGENTRUN_RUN_KEYS=1` is for a server that holds no tool keys of its own: a template's apply makes its agent with a warning naming the keys each run must bring, and a run without one of them is 409 `agent_not_runnable` at `keys.<NAME>`. The monid key stays the server's: an agent's monid tools are checked with it when the agent is saved, so with none on the server a template granting them is still refused at its apply.
