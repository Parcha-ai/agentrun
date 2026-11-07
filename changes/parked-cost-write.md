---
packages: @parcha/agentrun-kernel, @parcha/agentrun-serve
kind: fix
---
A Claude Code, Codex or OpenCode turn parked on a call that waits for a person no longer hides a request whose cost could not be recorded. Such a request now stops the booking as it does at any other time: the run fails with the cost-write error instead of going on past a request it did not record. The kernel exports `TurnParked`, the stop a host gives for a parked turn (`ModelPortOptions.stopped`): it refuses new requests but is no stop of the booking.
