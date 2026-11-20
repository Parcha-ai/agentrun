---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
GET /v2/computers says, on each provider's row, the run's folder a computer of it holds on this server now: `folder` is `bind` (Mode 1's folder of this machine), `archil` (the owner's Archil disk mounted), `sync` (a synced folder the runner keeps on the disk) or null (none). It is read by the rule a run's claim picks the folder by, in this server's mode and with the provider's keys and image as this server has them, so a caller no longer guesses from DAYTONA_ARCHIL_EGRESS. The API-only profile serves it too.
