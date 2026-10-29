---
packages: @parcha/pi-durable-disk
kind: fix
---
The next open's reap sends each process of a killed instance's commands one SIGKILL, even when both a record and a recorder's mark name it. It used to send the group's kill again, and each member's after its group's, and the count of signals it returned read 3 or 4 where 1 was meant.
