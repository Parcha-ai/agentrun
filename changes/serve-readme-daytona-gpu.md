---
packages: @parcha/agentrun-serve
kind: docs
---
The server README's GPU section says what a Daytona GPU sandbox is: one `H100` from Daytona's `daytona-gpu` snapshot, with its 16 vCPUs, 100 GiB of memory and 400 GiB of disk, and no mount, so this server refuses a Daytona sandbox with a `gpu` where its run folder is an Archil mount. It used to list six GPU types, up to eight, at 192 GiB of memory and 512 GiB of disk each.
