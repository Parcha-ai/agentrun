---
packages: @parcha/agentrun-harness
kind: feature
---
A planned handoff: `handoffs: [{ point, why, n?, where? }]` in a demo's spec and `--handoff` run a process that releases the run cleanly at an `effect.kept <tool>` crossing (the disk package's drain: sealed `sleeping`, claim released, exit 0) and a next process that opens it from the place. Nothing is killed: the supervisor writes one `handoff` host line (`gen`, `point`, `n`, `why`, `from`) when the process logged the crossing, exited 0 and `run.json` read again after the exit shows `sleeping` or `paused` with the released generation's seal, and a `handoff.failed` line (`crossing not logged`, `exit not 0` or `not released`) when it did not, in place of an unlanded kill. The manifest gains `handoffs`, and `generations` is 1 + landed kills + landed handoffs. `--kill` and `--handoff` are different runs, and a place without `status()` is refused for `--handoff` at load. A viewer never words a handoff as a kill.
