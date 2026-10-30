---
packages: @parcha/agentrun-serve
kind: feature
---
AgentRun Server runs decision workflows on Parallel Decisions too. A decision node that says `provider: "parallel"` is answered through `@parcha/agentrun-decisions` when the server's environment sets `PARALLEL_API_KEY`; a node that names no provider is still answered by Jev.
- In `/v2/openapi.json`, `Capabilities.workflows.decisions` is now marked `decisions/2`, and `info.x-agentrun-serve.fields` lists it. A client that validated against `decisions/1` would refuse the new provider id.
- `GET /capabilities` lists `parallel` in `workflows.decisions.providers`, `available` where its key is set and with a `reason` naming `PARALLEL_API_KEY` where it is not. `runJudge` is among `workflows.adapters` once either provider runs.
- With no Parallel key, a workflow whose nodes name `parallel` saves with a `not_set_up_here` warning naming the variable. A run of it is `409 agent_not_runnable` with `details.decisions: {parallel: {reason: "not_set_up_here", needs: ["PARALLEL_API_KEY"]}}`. A node naming a provider the server does not have is refused at save, `422`.
- The Parallel key never enters a run's environment. The server drops `PARALLEL_API_KEY` from every run's process, and hands it, with the TypeSafe key, to a workflow run's process once on the same inherited pipe, now as one object of variable name to value, for its decision providers alone.
- A run's typed questions go through the DSL's `judgeFromProviders`, to the provider each node names: a node naming one this server does not run is refused before its run, never answered by Jev in its place. Each receipt names the provider that answered.
