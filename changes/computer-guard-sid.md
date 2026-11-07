---
packages: @parcha/agentrun-computer
kind: fix
---
`process.signal` `INT` on a process started with a pty no longer risks signalling a process group outside the program's session. The daemon checks that the terminal's foreground group is in the program's session, then the guard signals it; in between, the group could end and its id go to a group in another session, which `kill` on that id would then reach with the guard's credentials. The guard now checks again right before it signals: a group that has no process left in the program's session is not signalled, and the reply, otherwise `{}`, says in `note` that `INT` was not sent. A group whose first process has ended while the rest of it runs (a pipeline's) is still signalled. The reply to such an `INT` now waits, bounded at 2 seconds, for the guard to say whether it sent the signal; a guard that does not answer in time is a `timeout` error that says the signal may or may not have been sent. Every other signal is unchanged.
