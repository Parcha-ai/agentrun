---
packages: @parcha/pi-durable-disk
kind: fix
---
**A place's outcome from `run.json` is in the run's word: `complete` or `failed`, not the record's status**
- `localPlace` (without the instance's outcome line) and `archilPlace` read a runner's outcome from `run.json`. Its
  `status` was the record's (`done`, `failed`, `running`, ...), which a supervisor would have to know the package to
  read. It is now `complete` when the run is `done` and the detail of the app's last status carries a `record`, and
  `failed` for anything else: done with no record, failed, or a run its instance left `running`, `paused` or `sleeping`.
  The generation, `code`, `message`, `record` and `storeSha256` are unchanged. An outcome line the instance prints is
  passed through as it is.
