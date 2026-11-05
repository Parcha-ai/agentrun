---
packages: @parcha/agentrun-serve
kind: feature
---
Runs execute in the VM box. An agent whose place is the VM box gets its `bash`, `read`, `write` and `edit` in a VM sandbox, the way a Daytona box works. The server holds the token and the SDK client, makes the sandbox, seeds it with the run's `work/`, copies what changed back at each turn's end and before the run's end, and ends it at the run's end, a cancel or an archive. A sandbox that is gone is made again on the next call. The run's process reaches its sandbox only through the server's box relay, which makes only that run's own tool calls. The VM box has no network: its provider takes a host list, but the server cannot read a sandbox's list back to check that it holds, so each box is made blocked, and capabilities say so in `network_reason`. It takes the CPU and memory limits a Docker box takes.
