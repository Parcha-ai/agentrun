---
packages: @parcha/pi-durable-disk
kind: fix
---
The next open's reap no longer takes a marked command for unmarked while the command is inside an exec. The kernel shows a process no environment during an exec, so a reap that read it then found no member, deleted the mark, and let the run reopen beside a live command.

The rules for a mark are now:
- A zombie or a gone process carries nothing, and its state is read first.
- Another user's process whose environment cannot be read is none of this server's.
- At an open, the reap reads a process of this uid whose environment reads empty or unreadable again over about 50 ms (after 2, 4, 8, 16 and 20 ms, all such processes together) and decides it by its first environment that reads. If it still reads empty after the window, it counts as unmarked.
- While commands run, the recorder reads each new command once per walk: one that reads empty is not recorded on that walk, and the next walk reads it again. A command already recorded is never dropped on an empty read; it leaves its record once it is gone or a zombie.

On macOS the same holds for a `ps -E` line with no environment after its arguments, judged on ps's real uid. That includes a line whose arguments changed across the read and that shows no environment yet (a command inside an exec): one of this uid is read again in the window, and another user's counts as unmarked. A line that shows an environment without the mark is unmarked at once, however its arguments change.
