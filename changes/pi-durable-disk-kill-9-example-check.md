---
packages: @parcha/pi-durable-disk
kind: docs
---
The kill-9 example decides which processes are still its cut command's by start time, not by the process group's number alone. A process that took that number after the command had ended no longer reads as the command still running. A process of the group that started before the second open still does, including a child forked late. On failure, the example names each such process: its pid, parent, state, start and command line. Its cleanup ends only the command's own processes.
