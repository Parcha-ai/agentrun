---
packages: @parcha/pi-durable-disk
kind: fix
---
`diskControl(disk)` builds the supervisor's control API from the `disk` SDK in one place, and the CLI and the acceptance rig both use it. The rig kept a hand-written copy without `exec`; without `exec` a delegation the control API lists with no path (a dead client's private directory among them) cannot be attributed, so every supervisor pass on a disk that lists one refused with `CONTROL_API_FAILED`. The rig now starts runs on such a disk.
