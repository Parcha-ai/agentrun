---
packages: @parcha/pi-transport
kind: feature
---
`probeAcknowledgedWrites` (`./testing`): whether a write a program was told was durable survives that program's death, so a runtime can be checked before it holds a session's disk.
