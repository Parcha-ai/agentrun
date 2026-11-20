---
packages: @parcha/agentrun-harness-claude
kind: fix
---
A Claude Code session resumed after a tool call waited for approval no longer tells the model the call's output is missing. The recovery note marks each completed or failed call whose result the resumed transcript already holds, including calls made inside codemode or tools_call, as being in the conversation above. Before, the note said the output of every call "is not shown here", so the model reported running the approved calls again.
