---
packages: @parcha/agentrun-codex
kind: feature
---
New package `@parcha/agentrun-codex`, held (not on npm yet): Codex as an AgentRun harness. `codexAdapter(options)` is an `AgentAdapter`, so `createHarnessRunner(codexAdapter(...), { store, tools })` runs a DSL `agent` node on Codex 0.164.0's app-server.
- Codex's built-in tools are off. A classic model is offered exactly the host's tools and `submit`; a code-mode model is offered code mode's `exec` and `wait`, which reach the host's tools by their own names. A test runs the pinned binary against a scripted model that calls every built-in and checks that nothing runs, writes or spawns.
- Codex's model traffic goes through a per-session proxy on the loopback interface that holds the provider key, forwards only `POST /v1/responses`, fixes the model, stores nothing at the provider, drops Codex's own web search and every tool that is not the session's (refusing any other provider-hosted tool), and asks the runner before every paid request.
- Codex runs in the session's own directories with an empty working directory and an allowlisted environment.
- Sessions are durable in the store the host lends: a session a process died inside resumes from its records, and a `never` tool's cut-off call is reported, never repeated, and a call delivered twice runs its tool once.
