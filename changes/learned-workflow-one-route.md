---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel, @parcha/agentrun-harness-claude, @parcha/agentrun-harness-codex
kind: fix
---
A learned workflow's model nodes, its `llm` call nodes and a call node's native search, on claude-agent, codex and opencode, are requests on the run's one route: the session's own model proxy, under a side key the proxy mints for the host (`ModelProxy.sideKey`, `AdapterSession.port`). They get the harness's own body rules, provider, key, price and booking, labelled `learned_workflow` on the session's records (`runner.request.side`), under the run's one cap. They reach an operator's gateway at ANTHROPIC_BASE_URL or AGENT_MODEL_BASE_URL as the harness's requests do, and never go around it, so a run there is offered its learned workflows (the learning pin's `workflows_off` is gone). A side request is never the turn's answer request: a content-filter stop on it does not halt the turn.
Upgrading: nothing to do. A pin written before this keeps the workflows it left out, and its `workflows_off` is no longer read; the next run is offered every learned workflow.
