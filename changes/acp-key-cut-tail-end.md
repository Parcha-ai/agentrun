---
packages: @parcha/agentrun-harness-acp
kind: fix
---
An ACP agent's failure words no longer keep a piece of a recipe key when the agent is still writing that key at the end of its stderr tail, or when two keys overlap: every place a key or its start appears is found in the text as written, then all of them are cut at once.
