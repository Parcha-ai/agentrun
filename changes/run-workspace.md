---
packages: @parcha/pi-durable-disk
kind: feature
---
`run --dir PATH --workspace work|harness/work` (and `localRun(root, { workspace })`) puts a local run's workspace at `<root>/work`, the default, or at `<root>/harness/work`, for a run whose harness's own tools run in a box that is lent `<root>/harness`.
- `--workspace` takes only those two values, and only with `--dir`. Anything else is a usage error (exit 2) naming why.
- `harness/` and `harness/work` are made mode 0700, one step at a time. A step that is a link, or not a directory, is refused by name (INVALID_ARGUMENT), so the workspace never lands outside the run's root.
- `run.json` records the workspace (`workspace`). A later open that names another is refused by name, and nothing is moved. A record without the field is `work`.
