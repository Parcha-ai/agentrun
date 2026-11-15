---
packages: @parcha/agentrun-computer
kind: fix
---
The exec pre-check's `kill` step reads a killed process that its parent has not reaped yet (a zombie) as ended. `kill -0` still finds a zombie, so a vendor whose `wait()` answered before the reap could fail the step even though its `kill()` worked. The probe now reads `/proc/<pid>/status` where it exists. Without `/proc`, `kill -0` alone answers, as before.
