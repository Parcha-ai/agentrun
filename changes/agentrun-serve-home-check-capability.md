---
packages: @parcha/agentrun-serve
kind: fix
---
`PUT /v2/agents/{agent_id}/home?check=1` now answers `501 unsupported_here` naming `home.check`, the capability that gates a home check, instead of `home.import` (agentrun.v2/0 erratum E4). Without `?check=1` it still names `home.import`.
