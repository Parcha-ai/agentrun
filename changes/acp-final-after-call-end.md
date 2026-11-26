---
packages: @parcha/agentrun-harness-acp
kind: fix
---
An ACP agent's answer is the text it writes after its last call ended, not that text joined to what it wrote while the call was in flight. Cursor 2026.11.13 writes a line such as "Running it now…" after announcing its own shell call and before it ends, and the answer read "…approved.6765". What it writes before a call ends is the answer only when nothing follows. The fake agent's native step takes `narrate`, text written in that window.
