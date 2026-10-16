---
packages: repo
kind: fix
---
**`apps/viewer`: only the host lines that name a process must carry `data.gen`**
- The viewer's format check asked every supervisor (`host`) line for `data.gen`, so a valid recording with a `picture`
  or a `box.receipt` line showed a broken-format banner. It now asks only the kinds whose fields name the process
  (`process.started`, `kill`, `result`, `kill.failed`, `kill.request.ignored`, `signals.failed`,
  `recording.carry.failed`, `run.json`, `delegation`, `revoke`, `fenced`); a host kind it does not know is not checked
  for it.
