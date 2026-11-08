---
packages: @parcha/agentrun-serve
kind: fix
---
A sandbox's `bash` runs a command for 120 s when the call names no timeout and for at most 600 s. A call asking for more runs at 600 s and says so in words: a `timeout_capped` diagnostic when it ends, its error when it times out. bash's description and its `timeout` parameter say both and point longer work at `bash_background`. Before, pi's bash had no default, so a command with none ran to the box's own 300 s deadline, and a call could name any timeout and spend the whole run in one command. The tool's name and schema are unchanged; only its words and its limits changed.
