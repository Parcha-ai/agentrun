---
packages: @parcha/pi-durable-disk
kind: fix
---
The next open of a run waits for every process of each command group it kills, not only the processes the killed incarnation had recorded. A command's child that no walk had recorded yet (a `sleep` its shell had just started) gets the group's SIGKILL but can die a moment after its leader. The open used to go on while it was still alive. Now it waits for it, and a member still alive at the deadline is a survivor: the open is refused and the next open tries again, as for a recorded one. The reap is a process-group reap: a descendant that left its group (`setsid` or `setpgid`) is ended only if a walk recorded it.
