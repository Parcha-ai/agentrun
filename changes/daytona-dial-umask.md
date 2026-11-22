---
packages: @parcha/agentrun-computer
kind: fix
---
Computer programs now run under `umask 077` where the adapter starts them: init on the exec path of E2B, Daytona, Agent37, boxd, Smolcloud and Morph, and `agentrun-dial` on E2B's and Daytona's dial (Daytona's is new; E2B's already did). computerd never resets the umask, so every program the computer's user runs there inherits it, and files they make come out `0600` where they used to come out under the vendor's umask (`022` on most). Init's start log (`/run/agentrun-init.log`) is root's alone there whatever the vendor's umask; `/work` stays the computer's user's, `0700`. Unchanged, under the vendor's or the image's umask: Modal (its entrypoint and its dial run no launch line of ours), Fly and Cloudflare (the image's CMD starts `agentrun-dial`), Orgo (its own init command) and Docker (`022`).
- A Daytona sandbox that reads asked-to-destroy while a dial create waits for it to start fails create at once, as one in `error` does, instead of waiting out `createMs`.
- A dial timeout's `agentrun-dial said:` words have every machine token replaced by `<token>` in the adapter, for any host's `dialLog`; Daytona's `dialLog` makes one read of the log of the command its create started.
