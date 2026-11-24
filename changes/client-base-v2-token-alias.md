---
packages: @parcha/agentrun-client, @parcha/agentrun
kind: fix
---
Both clients add `/v2` to a base URL with no v2 segment, as the CLI does, and take `AGENTRUN_TOKEN` for a server on this machine when `AGENTRUN_API_KEY` is unset; the CLI sends it only to the local server started with it.
