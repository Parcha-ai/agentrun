---
packages: @parcha/agentrun-computer
kind: fix
---
The Docker provider now starts each docker CLI call with only the environment names docker reads: where the daemon is, its config, PATH and HOME, and where a credential helper looks for a pull's login. Before, every docker child (list's inspect, create's run, connect's exec, the image pull and build) got the server's whole environment, so a key the server held reached it.
