---
packages: @parcha/pi-durable-disk
kind: fix
---
The next open's reap no longer sends the same SIGKILL twice when both a record and a recorder's mark name a command: each group and each process it signals gets one. The count of signals it returns no longer reads 3 or 4 where the record alone gives 2.
