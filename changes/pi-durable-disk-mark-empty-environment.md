---
packages: @parcha/pi-durable-disk
kind: fix
---
The next open's reap no longer takes a marked command for unmarked while the command is inside an exec. The kernel shows a process no environment during an exec, so a reap that read it then found no member, deleted the mark, and let the run reopen beside a live command.

The rules for a mark are now:
- A zombie or a gone process carries nothing, and its state is read first.
- Another user's process whose environment cannot be read is none of this server's.
- A process of this uid whose environment reads empty or unreadable is read again over about 50 ms (after 2, 4, 8, 16 and 20 ms, all such processes together) and decided by its first environment that reads. If it still reads empty after the window, it counts as unmarked.

On macOS the same holds for a `ps -E` line with no environment after its arguments, judged on ps's real uid.
