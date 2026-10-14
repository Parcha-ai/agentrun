---
packages: @parcha/pi-durable-disk
kind: fix
---
**A run on a local directory ends the commands a killed instance left running, before it resumes**
- pi makes each command the leader of its own process group, so a SIGKILL of the instance does not reach its commands,
  and a local run has no unit cgroup to end them: a command kept running, and writing in `work/`, beside the next
  incarnation. Now a local run's environment marks each command it starts (`PI_DURABLE_DISK_COMMANDS=<its token>` in the
  command's environment) and records each of its commands' groups (the leader and every descendant it has seen, each by
  pid, start ticks and boot) under `<root>/commands/`: another environment's commands in the same process, or the app's
  own detached helpers, are never its to record, and the next open, holding the owner lock, kills what is
  still the recorded process, waits until it is gone and clears the records, before the Harness opens (a new open step,
  `commands`, after `layout`).
- A kill reaches a process only when its pid, start ticks and boot all match a record, and never the opening process or
  its group. Only the instance writes records; a command that forged one could already kill what it names (it runs as
  the same user, or with `runAs` cannot write the instance's 0700 directory), so a record grants nothing.
- What is still alive at the reap's deadline (a process in an uninterruptible wait, or one it may not signal) refuses the
  open: `HeldError` with holder `commands` (`COMMANDS_ALIVE`, exit 76), naming the pids. The run never resumes beside
  it, its record stays, and the next open tries again. A record that cannot be written (a full disk) is said once on
  stderr and the recorder keeps trying. A command started within the last walk's interval (about 0.1 s) before the kill
  can be missed.
- A claim opts in with `Claim.commands` (the directory); `localRun`'s claim sets it. A mount's run is unchanged: its host
  ends commands with the unit's cgroup or the container.
