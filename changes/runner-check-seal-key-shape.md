---
packages: @parcha/agentrun-serve
kind: fix
---

`agentrun-serve runner --check --env` calls an `AGENTRUN_SEAL_KEY` that is not a seal key bad even when the runner's store does not open, in the words the start uses (its length, never its value), instead of "set, and not checked against the store". A key of the right shape stays unchecked there.
