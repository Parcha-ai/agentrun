---
packages: @parcha/pi-durable-agent, @parcha/agentrun-serve
kind: fix
---
A person's own message shows as they typed it, with any held key redacted. Its Timeline row (summary and text) shows a pasted key as `[redacted]`, and a pasted URL keeps its fragment and query (a console link's `#/runs/<id>` no longer reads as the bare origin). A run's title, taken from an agentic run's first message or a workflow run's input, holds no held key on the run's page, the runs list, Mission Control or an agent's runs, including a key a long value's cut would have split. The agent still gets its message and input exactly as given: only what is shown changes.
