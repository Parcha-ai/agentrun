---
packages: @parcha/agentrun-harness
kind: fix
---
`localPlace().release()` now stops any child it started that is still running (SIGKILL), and waits for it to exit. Before this, an attempt the supervisor gave up on left its child running. One example is an `--operator-kill` control that could not be removed. `demo()` then returned with an orphaned process that was still writing under the run's scratch directory, and removing that directory could fail with `ENOTEMPTY`.
