---
packages: repo
kind: docs
---
New example `examples/install-probe/`: `npm install <name>@<version>` with lifecycle scripts on, in a throwaway Docker box
of `@parcha/pi-transport`, and the connections `strace` saw (`installProbe`, or `startInstall` and `attachInstall` from any
process, and `killBox`). Install scripts never run on the host; without Docker `startInstall` throws a typed
`DOCKER_UNAVAILABLE`. The connection list is what was seen, not a proof of what was not.
