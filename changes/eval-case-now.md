---
packages: @parcha/agentrun-serve
kind: feature
---
A template eval case can set its runs' clock: `now: 2026-11-14T09:00:00Z` in its `case.yaml` (a date and time with its offset, checked before any run) is each run's current date and time. The run's environment line says that day, as does claude-agent's turn date, and each `llm` grader is told the clock the run ran on, so a rubric can say "the run's date". A dated fixture case no longer drifts a day each day it is run. Without `now`, nothing changes.
- Only the eval's own in-process server honours `now`; no package field, API field, setting or environment variable sets a run's clock, and a case with `now` refuses to run with `--server`.
- A shell's `date`, a browser's page and Codex's own date still read the machine's clock.
