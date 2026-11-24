---
packages: @parcha/agentrun-serve
kind: fix
---
A server whose Docker host-address read failed at the start now cuts a retry's read in flight at its close and removes that read's helper container within the stop's deadline. A read whose docker client an outside signal killed removes its container too. The retry also starts when `AGENTRUN_DOCKER_HOST_ADDRESSES` is set, and there it only removes the containers the failed read left.
