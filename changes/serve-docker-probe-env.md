---
packages: @parcha/agentrun-serve
kind: fix
---
The server's own calls to Docker (whether a daemon answers, at its start and at a run's; which daemon the docker CLI reaches; the data volume's mounts; the Docker host's addresses) now start `docker` with only the variables it reads, as every docker call of the Docker computer does. Before, they got the server's whole environment with its secrets cut out.
