---
packages: @parcha/agentrun-serve
kind: fix
---
A server's stop no longer waits out a Docker host-address read that the runner beside it started with no signal: the stop's signal cuts that read, and its helper container is removed by name within the stop's deadline.
