---
packages: @parcha/agentrun-serve
kind: fix
---
Two files uploaded in one millisecond now list newest first in `GET /v2/files`. Upload ids are minted by the same monotonic UUIDv7 as agent ids, so each sorts after the one before it; before, two ids in one millisecond carried random bits after the time and could list in either order.
