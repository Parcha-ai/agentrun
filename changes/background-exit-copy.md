---
packages: @parcha/agentrun-serve
kind: fix
---
A background process's `exit` file in `work/background/<id>/` is no longer lost at the run's end. The process's runner wrote the exit code it trusts before the display copy in `work/`, and the run's end treats a process as ended once that trusted code exists, then destroys the box. So the display copy could be cut off and never land. The runner now writes the display copy first, so the box's destroy at the run's end, and the run's recorded end, both come after `exit` is in the run's files.
