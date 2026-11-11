---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: breaking
---
A Daytona GPU computer is now made from Daytona's GPU snapshot `daytona-gpu` and has its one H100: give image `"default"` or `"daytona-gpu"` and `gpu: { type: "H100", count: 1 }`, with no mount. Any other snapshot, type or count, or an Archil mount (so serve's Mode 2), is refused in words; the create sends no resource fields beside the snapshot, and notes who installed the daemon.
