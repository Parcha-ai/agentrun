---
packages: @parcha/agentrun-harness-acp
kind: fix
---
Cursor is now told at each session's start that its own Write tool is refused, so it writes a file with a shell command (which asks the person first) and never stops at that refusal without an answer; a shell command the person denies is their answer, not asked again. An ACP recipe can carry `instructions`, given to the agent after the session's own, by the same route. A conversation begun before its recipe had them (or changed them) gets them once, ahead of its next prompt, when an agent with no system prompt loads it.
