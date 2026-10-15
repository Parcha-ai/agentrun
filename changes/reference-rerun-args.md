---
packages: repo
kind: fix
---
The reference example's reconcile now hands a host's `rerun` the args the journal kept for an effect (`RecoveryEffect.args`). Before, a call admitted but never sent (a kill between admission and the send) could not be sent again after the kill, and the resumed run was refused with `FROZEN_EFFECT_UNKNOWN` even for a host that could rerun it. With a `rerun`, the resumed process now sends it exactly once.
