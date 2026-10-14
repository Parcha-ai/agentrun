---
packages: @parcha/pi-durable-disk
kind: fix
---
**A run on a local directory ends the commands a killed instance left running, before it resumes**
- pi makes each command the leader of its own process group, so a SIGKILL of the instance does not reach its commands,
  and a local run has no unit cgroup to end them: a command kept running, and writing in `work/`, beside the next
  incarnation. Now a local run's environment records each command's group (the leader and every descendant it has seen,
  each by pid, start ticks and boot) under `<root>/commands/`, and the next open, holding the owner lock, kills what is
  still the recorded process, waits until it is gone and clears the records, before the Harness opens (a new open step,
  `commands`, after `layout`).
- Only the instance writes records, and a kill reaches a process only when its pid, start ticks and boot all match one;
  never the opening process or its group. A command started within the last walk's interval (about 0.1 s) before the kill
  can be missed.
- A claim opts in with `Claim.commands` (the directory); `localRun`'s claim sets it. A mount's run is unchanged: its host
  ends commands with the unit's cgroup or the container.
