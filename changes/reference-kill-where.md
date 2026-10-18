---
packages: repo
kind: feature
---
A reference kill takes `where: { field: value }`: it fires only at an announced crossing whose info has those values (`cross(point, { info })`, which the crossing log records), and composes with `n` as the nth matching crossing. `transport.tool.started` fires for every tool, so `{ point: "transport.tool.started", where: { tool: "install" } }` lands on the install step. A storm takes no `where`.
