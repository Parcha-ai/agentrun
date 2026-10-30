---
packages: @parcha/agentrun-kernel
kind: feature
---
A boxed session reaches the host only through two Unix sockets the box is given, in the session's own local runtime directory (`MachineBox.runtimeDir`; by default one per session under the OS's temp directory, made 0700, this user's own, refused on FUSE or a filesystem shared between hosts, removed at close).
- The model front listens on its socket only (`ModelProxyOptions.socketPath`), and the harness sees it at a port of the box's own loopback (`MachineBox.modelPort`).
- One egress proxy per session, the host's (`MachineBox.egress`: a port and a `start(socketPath)`), started at open and closed after the session's last box. The box's environment names it to every client that asks for a proxy (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY` for the model's own port, `NODE_USE_ENV_PROXY`).
- The box's first command is the kernel's forwarder (`box-forward.js`, bound in with node): it serves each socket on the box's loopback, runs the harness on its own stdio, passes `TERM`, `INT` and `HUP` on, and exits as the harness did.
- `listenSocket` replaces a socket a dead process left (nothing answers it) and refuses a live one by name, never taking it over. `BOX_MODEL_SOCKET` and `BOX_EGRESS_SOCKET` name where a box binds the two.
- `MachineBox.modelSocket`, `egressSocket` and `egressPort` are replaced by the machine's own sockets and `modelPort` and `egress`.
- `previousBox` (a record and the reap of the box that wrote it) replaces `MachineBox.previous` and is reaped at every open, boxed, unsandboxed, unavailable or none: a session never starts beside a box of its own that a reap has not counted empty (`box_not_empty`).
