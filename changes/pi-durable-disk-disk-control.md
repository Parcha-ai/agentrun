---
packages: @parcha/pi-durable-disk
kind: fix
---
The acceptance rig builds the supervisor's control API with the package's own `archilControl` (the one the CLI uses) instead of a hand-kept copy. The copy had no `exec`, and without `exec` a delegation the control API lists with no path (a dead client's private directory among them) cannot be attributed, so every supervisor pass on a disk that lists one refused with `CONTROL_API_FAILED`. The rig now starts runs on such a disk.
