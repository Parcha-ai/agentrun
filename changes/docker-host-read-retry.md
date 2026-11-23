---
packages: @parcha/agentrun-serve
kind: fix
---
A server in a container (compose.yaml) whose read of the Docker host's addresses failed at the start (a busy host's Docker ran out of time) now reads them again in the background, after 15 s, 30 s, 60 s and 120 s, then every 4 minutes, until a read answers or the server stops. Once one does, Docker is offered with no restart: capabilities and a run's start see it, and the log says `docker_host_addresses` and `boxes` again. The start's banner still says what the start found.
- The read's helper containers (`agentrun-host-read-*`) no longer pile up: a read that ran out of time or failed removes its container by name, and one Docker didn't confirm gone is removed again at the next read. A failed read's words name its container only when it is still there, with the `docker rm -f` that removes it.
