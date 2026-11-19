---
packages: @parcha/agentrun-serve
kind: fix
---
A run on a computer that mounts its folder attaches again when the run is a process of its own (every runner since v0.1.0-beta.46). The run's process hands its mount check to the runner's Workspace across the run channel, where the check's read-back is a handle answered as a promise; attach compared the computer's read-back against that unawaited promise, so every such run was refused about 25 seconds in with `does not hold this run's folder at /workspace: it mounts <the right folder> ..., not undefined:/undefined in undefined`. Attach now awaits the expected read-back.
