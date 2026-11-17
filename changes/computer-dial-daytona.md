---
packages: @parcha/agentrun-computer
kind: feature
---
Daytona computers can dial the server instead of being reached through the toolbox: set `connect: "dial"` (the server's `daytonaConnect` setting, or `COMPUTER_DAYTONA_CONNECT` for the conformance module). Exec stays the default. On dial the sandbox gets the boot env as its `env`, and the box snapshot's entrypoint runs `agentrun-dial`. Daytona runs a snapshot's entrypoint, never the image's CMD, so `box/build-daytona.py` now names the CMD as the snapshot's entrypoint: a box snapshot built before this has none, and dials only once it is built again. On dial a Daytona computer takes no Archil mount and no GPU, each refused in words, and the conformance module's `dialKit()` refuses, as E2B's and Modal's do. On dial the module's run image is the box snapshot, `agentrun-archil-<recipe hash>`.
