---
packages: @parcha/pi-durable-disk
kind: fix
---
`launchStatus` (and so the Daytona host's `status`) reports a launch that ended as `failed` or `stopped` as soon as the launcher has saved its final `exited` record and no instance lives, even while the launcher's own process is still exiting. It used to say `running` until that process was gone, so a status read in that moment (a supervisor poll, or the terminal-exit test under load) saw a finished launch as live. `stop` returns at once with the recorded outcome and still sends SIGTERM to a launcher process that outstays its record.
