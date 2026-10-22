---
packages: @parcha/agentrun-harness
kind: fix
---
A host line written by a process that has no supervisor (a run's child, a tool box's `box.receipt`) is now the supervisor's kind of line: no event-level `gen`, the process it is about in `data.gen`, as RECORDING.md 3.1 says. Before, `recorder.host()` without a supervisor stamped the process's `gen` on the line. `finishRecording` numbers the supervisor's space (live host lines with no `gen`) once, in order, since the supervisor and each process counted from 0.
