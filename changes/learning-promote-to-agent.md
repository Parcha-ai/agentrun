---
packages: @parcha/agentrun-serve
kind: feature
---
A learned workflow can be made an agent of its own. The owner clicks "Make this an agent" on an active learned workflow in the Learning tab (`POST /v2/agents/{agent_id}/learning/workflows/{name}/promote`), and the server makes a new workflow agent from its `workflow.json`: its runs run the workflow's nodes with no agent loop and answer the workflow's output, and pipelines and triggers can call it as any agent. Only an active workflow is made an agent (one that waits for the owner's OK, or was retired, is `409 learned_not_active`), only from the owner's password session (a token is 403), and only once it passes the checks a restore makes and a workflow revision's save makes. The new agent's tools are the ones its call nodes call, under the source agent's own tool settings, approvals and default cap, never more. The learned workflow stays where it is.
Upgrading: nothing to do.
