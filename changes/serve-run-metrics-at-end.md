---
packages: @parcha/agentrun-serve
kind: feature
---
A run's end writes its metrics to the agent store, each time it is carried back: its tokens, model requests, models and tool calls over every conversation of its store (a workflow's model nodes and a harness's session included), the effort its process ran at (the run's `effort`, else its revision's `thinking`, else `AGENT_THINKING`, else medium; codex's max is xhigh), and on claude-agent or codex the model its revision names, since their journal names the harness. A follow-up's end replaces them, and a run whose process died gets them from what its store holds. Metrics the store refuses (a tool name past its limit) leave the run ended without them, never unended. A workflow's decisions are not in its token counts yet.
