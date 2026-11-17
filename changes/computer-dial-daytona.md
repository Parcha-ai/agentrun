---
packages: @parcha/agentrun-computer
kind: feature
---
Daytona computers can dial the server instead of being reached through the toolbox: set `connect: "dial"` (the server's `daytonaConnect` setting, or `COMPUTER_DAYTONA_CONNECT` for the conformance module). Exec stays the default. On dial the sandbox gets the boot env as its `env`, and the box snapshot's entrypoint runs `agentrun-dial`. Daytona runs a snapshot's entrypoint, never the image's CMD, so `box/build-daytona.py` now names the CMD as the snapshot's entrypoint, and names the snapshot `agentrun-box-<recipe hash>`: the `agentrun-archil-<recipe hash>` snapshots it built before have no entrypoint and never dial. A server on exec that names one of those keeps working. On dial a Daytona computer takes no Archil mount, no GPU and not Daytona's default snapshot, each refused in words, and the conformance module's `dialKit()` refuses, as E2B's and Modal's do. On dial the module's run image is `agentrun-box-<recipe hash>`.
