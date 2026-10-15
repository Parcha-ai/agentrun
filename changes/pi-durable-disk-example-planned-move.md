---
packages: @parcha/pi-durable-disk
kind: docs
---
New example, `examples/planned-move/`: a run moves from this machine (a systemd unit) to a Daytona sandbox at a step boundary, by hand-over and not take-over. The first incarnation sets `paused` with where it is going and releases (sealing the store); the supervisor starts it in a box with `ensureRunning(..., { demand: true })`, which revokes nothing; the second incarnation's `beforeResume` reads `previous` and tells the agent it moved before any step resumes. It needs an Archil scratch disk, a Daytona key and a host set up for production, and the same run user uid on both hosts. Its test skips without the keys.
