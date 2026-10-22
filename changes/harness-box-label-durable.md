---
packages: @parcha/agentrun-harness
kind: fix
---
A box label claimed in the run's box ids directory is now durable before it is used: after the winning `link(2)` of `box-N.json` (and of a host box's `host-<key>.json`), the harness fsyncs the ids directory itself, then hands the label out. A fix to merged behaviour: the linked file was fsynced but its directory entry was not, so a crash could keep a synced recording line naming `box-N` and lose `box-N.json`, and the next claim would take `box-N` again, two boxes with one label in one recording.
The same holds for a label's receipt state (`open`, `ended`, `written`), rewritten by `rename(2)`: the directory is fsynced before the new state is relied on, so a crash can no longer bring back a state that says a written receipt is unwritten and have the same box's receipt written twice (a cost counted twice).
A directory that cannot be fsynced refuses the claim by name (`cannot be made durable`): the label is never used, and the box is destroyed as for any label that cannot be kept.
