---
packages: @parcha/pi-durable-disk
kind: feature
---
**The CLI runs on a local directory: `pi-durable-disk run --dir PATH --app MODULE`, no disk and no key**
- `run --dir PATH` is the instance on a directory of this machine (`localRun`): the same app contract and exit codes as
  on a disk (76 when another process holds the run, or when a process its last incarnation left will not die; 75 when
  fenced) and the same run flags but the Archil ones. `--disk`, `--region`, `--mount-root`, `--archil` and
  `--token-stdin` beside `--dir` are a usage error (exit 2). `--id` defaults to the directory's name. Example 01's app
  runs as it is: `kill -9` the instance and run the same command again, and it resumes.
- `status --dir PATH` reads `run.json` from the directory and says whether its holder still runs (`running`, `stopped`,
  or `gone` from another boot).
