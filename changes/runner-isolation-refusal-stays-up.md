---
packages: @parcha/agentrun-serve
kind: fix
---
A host that won't let the runner start its run-as helper (spawn EPERM, as on Render) leaves the runner up, refusing runs with the words to set `AGENTRUN_RUN_USER=same`, instead of stopping the container. Every refusal of the runner's isolation now does: the image's `runner` process says why and stays up claiming nothing until it is stopped (exit 0), where its exit stopped the container, and a server with its runner in its own process serves on with no runner instead of exiting.
