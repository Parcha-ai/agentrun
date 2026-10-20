---
packages: @parcha/pi-durable-disk
kind: fix
---
An instance whose app releases the run itself now exits 0 instead of staying up with no mount.
`pi-durable-disk run --app` used to keep running after an app called `await run.release()` in `onOpen` and returned (the shipped examples hid it by calling `process.exit(0)`): the unit stayed `active` with the mount gone, and stopping it logged `release failed` ("Session is closed") and exited 1, so the unit ended `failed`.
- The instance ends with exit 0 as soon as `onOpen` has returned and the run is released; a release the app starts later is joined by a stop (SIGTERM), which then exits 0 without a drain and without writing a wake to the closed run.
- `DurableRun` gains `releasing`, true once `release()` began, which the instance reads. A caller that implements `DurableRun` itself needs the property.
- `pi-durable-disk --help`, `help` and `<command> --help` print the usage on stdout and exit 0 (they were an unknown-option usage error, exit 2).
