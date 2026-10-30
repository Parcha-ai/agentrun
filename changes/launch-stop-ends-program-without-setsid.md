---
packages: @parcha/pi-transport
kind: fix
---
On a box without `setsid`, `launchStop` now ends the program. There, the program's runner leads no process group, so the stop's group signals reached nothing: the program kept running while the stop reported `stopped`. The drain's SIGTERM now goes to every process under the runner, and the kill stops the runner and each process under it before killing them all. On every box, a stop that cannot confirm the program is gone within 2 s of its kill now fails with `the program did not end: <what is left> still there after its kill`, writes no `stopped` state, and leaves the stop for a later one to take over.
