---
packages: @parcha/agentrun-serve
kind: fix
---
`agentrun-serve eval-template --server URL` stops before any run, and exits 2, when that server was started with `AGENTRUN_RUN_KEYS=1` and lacks a tool key the package declares: an eval's runs carry no `keys`, so the server would refuse each one. The message names the key and says to run the eval without `--server`, or on a server that holds the key. In 0.1.0-beta.54 every case ran into that 409 and failed, and the eval exited 1.
