---
packages: @parcha/pi-durable-disk
kind: fix
---
An instance whose app released the run ends by itself: `pi-durable-disk run --app` exits 0 once `onOpen` has returned and the run is released, so the unit does not stay up with no mount.
- A stop (SIGTERM or SIGINT) after the app's release, from `onOpen` or later, exits 0 with no drain and no wake written to the released run.
- `DurableRun` gains `readonly releasing: boolean`, true once `release()` began. A caller that implements `DurableRun` itself must add it.
- `pi-durable-disk --help`, `help` and `<command> --help` print the usage on stdout and exit 0.
