---
packages: repo
kind: fix
---
The console's agent editor no longer offers or ticks a workflow's call-only tools (`pdf_pages`, `llm`: `call_only` in `capabilities.tools`) for an agentic agent, so a new agent created with its default tools saves instead of being refused with a 422. The console keeps each tool's `call_only` and `nodes` from capabilities; no harness runs a call-only tool, so an agentic agent's Tools step leaves them out, new and existing alike, and an existing agentic agent that names one shows it as workflow-only, ticked, so it can be unticked rather than dropped silently. A workflow agent still picks them: its call nodes need them listed in its revision's tools.
