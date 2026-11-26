---
packages: @parcha/agentrun-harness-acp
kind: fix
---
Cursor is now told at each session's start that its own Write tool is refused, so it writes a file with a shell command (which asks the person first) and never stops at the refusal without an answer. An ACP recipe can carry `instructions`, given to the agent after the session's own, by the same route.
