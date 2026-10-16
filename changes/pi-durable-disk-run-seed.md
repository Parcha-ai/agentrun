---
packages: @parcha/pi-durable-disk
kind: feature
---
**`seed`: what a new run starts with, written before anything sees the run**
- `openDurableRun` and `openRunLease` take `seed: (dir: { root, storePath, workDir }) => void | Promise<void>`. It runs
  once, on the open that finds no `run.json`: inside the run's first claim, with the owner lock held, after `store/`,
  `work/` and `tmp/` exist, and before `run.json` is written and the store opens (step `seed`). What it wrote is made
  durable (the claim's barrier) before `run.json` publishes the run.
- It never runs for a run that has `run.json`. A seed that throws fails the open with its own error, and a process killed
  while it seeds leaves the run unpublished; either way the next open seeds again. It works the same with `localRun`.
- New types `RunSeed` and `RunSeedDir`, exported from the package and from `./lease`.
