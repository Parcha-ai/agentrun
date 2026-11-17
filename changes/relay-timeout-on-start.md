---
packages: @parcha/agentrun-computer
kind: fix
---
The Cloudflare relay's computer object sets the container's inactivity timeout when it starts, for a container that is running and not ended, so a relay redeploy no longer leaves the container without one until the next hourly alarm.
