---
packages: @parcha/agentrun-serve
kind: fix
---
The server now ends computers a crashed runner left behind. When its runner starts, and every 10 minutes after, it looks at each computer provider whose keys it has and whose vendor doesn't end computers itself (Docker, Orgo), and ends this server's computers that are past their deadline. It never touches another server's computers on a shared account or Docker host, or a computer a running run still holds. A provider it can't reach is logged once, and the others are still swept. It doesn't run under `--faux`.
