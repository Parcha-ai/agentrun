---
packages: @parcha/agentrun-computer
kind: feature
---
`DockerProvider` finds, checks and sweeps computers. `attach({ id } | { labels })` finds exactly one computer, `list(labels)` reads back each one's labels, deadline, state and network, and `network(ref, policy?)` reads the network back (`none`, `open`, or anything else in words) and refuses any change, since a Docker computer's network is fixed at create.
- `create()` ends with a drift check, `drift(spec, inspected, hello, expected)`: the network, dropped capabilities, no-new-privileges, the pids, memory and CPU quota (with serve's defaults when the spec names none), the user it runs as, the `/work` and `/run/agentrun` tmpfs mounts with that user's uid and gid and mode 0700, the read-only daemon mount, the entrypoint and `init --deadline <the label's deadline>`, the labels, and hello's version, os, capabilities and architecture must match what was declared, or the computer is deleted and `create()` refuses with every mismatch in words.
- `connect()` refuses a daemon of another version, or one missing a capability the provider declares.
- `sweep(provider, { labels?, now? })` deletes the computers of a `lifetime: "janitor"` provider whose deadline has passed or is missing, stopped (as a computer is once its deadline ends it) or running, and keeps the rest; it refuses a provider whose vendor ends computers itself. A caller runs it on a schedule.
