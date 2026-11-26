---
packages: @parcha/agentrun-serve
kind: fix
---
A held Cursor run (`hold: true`) that its model kept from running at its create no longer opens `CURSOR_API_KEY` at its claim: the key is never decrypted, never laid on its environment, and a runner that starts each run in a process of its own hands that process none. With no `CURSOR_API_KEY` set, such a run holds its computer instead of failing its claim for the key. Such a run is never handed the Claude login either: its claim reads none, so a login turned on after its create (this machine's own, on a runner whose runs are users of their own) never refuses it, and a runner asked by the run's own process answers none. A launch whose `hold` is not an object (a corrupt row) is read as held with its model refused: its start and its messages are refused (`409 agent_not_runnable`) in words that name the field, and its claim opens no model key; before, it read as not held.
