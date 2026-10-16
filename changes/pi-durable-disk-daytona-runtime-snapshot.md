---
packages: @parcha/pi-durable-disk
kind: ci
---
**The Daytona live helpers build a runtime snapshot, so a box is ready in about 2 s instead of 16 s**
- `test/live/daytona-snapshot.ts build <commit>` builds `pda-p9-runtime-<commit>-<stamp>` from `snapshotDockerfile`:
  `daytona-medium`'s image with the pinned Node and archil client, the run user, the wrapper, the sudoers drop-in and the
  package's dependencies. `prepareOnSnapshot` is the matching `prepare` for a `daytonaHost` start with `snapshot: <name>`:
  it puts the checkout's package source over the snapshot's `node_modules` and installs dependencies only when they
  changed. `check`, `baseline` and `delete` boot, compare and remove.
- The ledger (`P9-STATE.json`) records snapshots too. A snapshot is built once under a new name, never over an existing
  one, and only one this lane built can be deleted.
- No package code changes: `daytonaHost` already takes `snapshot` and `prepare`.
