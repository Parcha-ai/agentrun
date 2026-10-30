---
packages: @parcha/pi-durable-disk
kind: fix
---
The next open's reap no longer sends the same SIGKILL twice when both a record and a recorder's mark name a command: each group and each process it signals gets one. The count of signals it returns no longer reads 3 or 4 where the record alone gives 2.

On macOS the reap reads a recorder's mark from a process's environment only, never from its arguments. A process's arguments are read before and after its environment, and must agree. A process whose environment listing holds the mark but whose arguments change between the reads (it exec'd) is read up to three times. If it still can't be read, the open is refused with the mark and records kept and nothing signalled, instead of the mark being dropped beside a live command.
