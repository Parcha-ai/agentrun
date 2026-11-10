---
packages: @parcha/agentrun-serve
kind: fix
---
A runner no longer crashes when an approval's answer, a message or a steer arrives just as a run's claim ends before its session is ready. The command waits for the run's next claim instead of being lost. A standalone runner (`agentrun-serve runner`) that meets an error nothing handles now says so with the stack and exits 1, so its claims lapse and another runner takes the runs back, instead of holding runs whose loop is dead.
