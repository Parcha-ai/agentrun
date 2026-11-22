---
packages: @parcha/agentrun-computer
kind: fix
---
Computer programs now run under `umask 077` on every hosted provider, exec and dial: `agentrun-dial` on every provider that starts it itself (Daytona's dial now, E2B's already did), and init on the exec path. computerd never resets the umask, so every program the computer's user runs inherits it, and files they make come out `0600` where they used to come out under the vendor's umask (`022` on most). Docker computers keep `022`. Init's start log (`/run/agentrun-init.log`) is root's alone whatever the vendor's umask; `/work` stays the computer's user's, `0700`.
- A Daytona sandbox that reads asked-to-destroy while a dial create waits for it to start fails create at once, as one in `error` does, instead of waiting out `createMs`.
- A dial timeout's `agentrun-dial said:` words have every machine token replaced by `<token>` in the adapter, for any host's `dialLog`; Daytona's `dialLog` makes one read of the log of the command its create started.
