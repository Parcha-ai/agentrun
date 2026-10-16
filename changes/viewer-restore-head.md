---
packages: repo
kind: fix
---
**`apps/viewer` and `scripts/recording/validate.mjs`: a restore whose pi committed once at open is accepted (RECORDING.md draft 37)**
- A restore's process may start at `head + 1` when its own snapshot is at commit `head`: pi commits once at open when a
  generation was running, and that commit's state is in the snapshot. Both checkers refused such a recording (the
  viewer's "the restore's head is not the process's first new commit", and the validator's continuity check). A first
  new commit above `head + 1`, `head + 1` without the snapshot at `head`, and every move keep failing as before.
