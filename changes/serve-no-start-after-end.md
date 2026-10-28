---
packages: @parcha/agentrun-serve
kind: fix
---
**A run that ended is never started again, so its place is free once it reads failed**
- A run's first message waits for the run's process to come up. When that process failed at its start, the settle that ended the run could finish while the wait read the run's `run.json`, and the wait then started the process again: a second process for a finished run, holding its place, so the next start under `--max-runs` could be a 429 `rate_limited`.
- The wait now checks whether the run ended after each read, and a run that ended or is finishing is never launched.
