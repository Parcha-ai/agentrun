---
packages: @parcha/agentrun-computer
kind: fix
---
A dial desktop whose display is down fails `connect` and `watch` as drift, as on exec; before, `connect` answered with a desktop that had no screen.
