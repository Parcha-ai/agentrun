---
packages: @parcha/agentrun-serve
kind: fix
---
A command the runner's dispatch held before it chose a run's loop (an approval's answer, a message, a steer) is no longer lost when its first delivery fails. The dispatch tries it again while the loop runs, at most five times in all, and then leaves it for the run's next claim. A standalone runner (`agentrun-serve runner`) that meets an error nothing handles now says so with the stack and exits 1, so its claims lapse and another runner takes the runs back, instead of holding runs whose loop is dead.
