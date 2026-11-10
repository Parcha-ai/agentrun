---
packages: @parcha/agentrun-serve
kind: fix
---
A run's timeline reads a call that waited for approval in order on the runner, as on main: the call's own rows, then its approval row, then what came of it, also when the call's result comes in after the answer (the approval and outcome rows are served anew below it). A write that waited no longer shows its own "Saved" row: what an allowed write saved is its outcome row's to say, and a denied one saved nothing.
