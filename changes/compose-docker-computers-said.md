---
packages: @parcha/agentrun-serve
kind: fix
---
A server that isn't on its Docker's own host (in a container given the host's Docker socket, as compose.yaml runs it, or with a `DOCKER_HOST` that isn't a local unix socket) no longer offers Docker computers it can't run: a run's Docker computer mounts the run's folder by the server's own path, which that Docker doesn't have. Capabilities say why in plain words, an agent that names a Docker computer is refused at its run's start in them instead of failing at create, and an agent with no computer runs on the runner with the file tools, as on a machine with no Docker. `AGENTRUN_DOCKER_HOST_ADDRESSES` (a comma list of the Docker host's own IP addresses, checked at the start) is passed to the Docker provider for its egress proxy, ready for when Docker computers run from a container.
