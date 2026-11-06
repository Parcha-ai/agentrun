---
packages: @parcha/agentrun-serve
kind: fix
---
On a Mac, the box network's proxy container is handled more strictly. The server uses the container id `docker run` prints only when it is a full 64-hex-digit id; any other output counts as a failed start and is never passed to `docker rm`, `inspect` or `logs`. When the server stops, it removes the proxy it started by that id, and also any container that carries this server's own `agentrun.egress` label. So a proxy whose `docker run` gave no answer (the client cut off while the daemon made it) no longer outlives the server. A container without that label is never touched.
