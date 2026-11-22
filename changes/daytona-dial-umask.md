---
packages: @parcha/agentrun-computer
kind: fix
---
`agentrun-dial` now runs under `umask 077` on every provider that starts it itself, Daytona's dial included (E2B's already did), and the exec path starts init under it too, so init's start log (`/run/agentrun-init.log`) and a `/work` it makes are root's alone whatever the vendor's umask.
- A Daytona sandbox that reads asked-to-destroy while a dial create waits for it to start fails create at once, as one in `error` does, instead of waiting out `createMs`.
- A dial timeout's `agentrun-dial said:` words have every machine token replaced by `<token>` in the adapter, for any host's `dialLog`; Daytona's `dialLog` makes one read of the log of the command its create started.
