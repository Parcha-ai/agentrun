---
packages: @parcha/agentrun-computer
kind: feature
---
The conformance case `isolation.vendor-agent` now fails when anything but computerd listens on TCP or UDP in the network of the computer's user, naming the port ("tcp port 8080 listens in the user's own network (on 0.0.0.0, pid 77 (python3)), and it isn't computerd's").
- `computerd probe --sockets` adds `listeners`: the TCP sockets in LISTEN and the UDP sockets bound with no peer in its own network namespace, read from `/proc/net/tcp`, `tcp6`, `udp` and `udp6`, each with its address, port, uid, the process that holds it where `/proc` shows that process's descriptors, and whether that process runs computerd. A table it cannot read is named in `incomplete`, and the case fails on it.
- Under `--own-network` computerd listens on nothing in that namespace, so today any listener there fails the case. The Archil case `mount.archil-isolated-durable` runs the same check.
