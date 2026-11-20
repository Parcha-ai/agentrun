---
packages: @parcha/agentrun-serve
kind: feature
---
A runner that holds many customers' runs keeps per-run users without putting its own user in 256 groups, and its operator can stop owners from allowing private-network hosts (`AGENTRUN_PRIVATE_HOSTS`). See [docs/multi-tenant-runners.md](https://github.com/Parcha-ai/agentrun/blob/main/docs/multi-tenant-runners.md) for the threat model.

- In the image, the server's user (node) is now in one group, its own, and in no slot's group. A platform that reads a user's groups at start (Northflank's environment injector refused node's 257 groups) can run the image with per-run users on, so `AGENTRUN_RUN_USER=same` is no longer needed there.
- A run's folders are given to its slot before it starts (`agentrun-runas own <slot>`: the slot's uid, node's group, folders `2770` with the setgid bit) and back to node at its end (`own runner`). The server reads a running run's files through its one group; no other slot can enter them, nor the slot's next run. The helper gains `cap_chown` (kept alone while it gives folders, each entry changed through a descriptor opened without following a link); `reown` and `reap --fix` are gone. A give-back that fails retires the slot, as a reap that does not hold does.
- A run that shuts one of its folders (`chmod 700`, which drops its setgid bit) hides it from the server until the run ends.
- `AGENTRUN_PRIVATE_HOSTS` bounds the private-network hosts an owner may allow an MCP server or a calendar on (Settings → MCP servers). Unset, the owner's list holds, as before. `none` reads no owner's list and saves only an empty one (422, naming the switch, otherwise): set it on a server or runner many customers share, and on each runner, which reads its own environment and says the bound at its start. A comma list of address ranges (`10.20.0.0/16,fd12:3456::/32`) allows a listed host only inside them. A value that is neither reads as `none`. `GET /v2/capabilities` lists it under `switches`.
