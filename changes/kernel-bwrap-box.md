---
packages: @parcha/agentrun-kernel
kind: feature
---
The kernel's `Box` seam has a bubblewrap implementation for Linux, `bwrapBox`.
- **What a box sees.** A harness runs as the server's own uid in its own user, pid, mount, network, IPC and UTS namespaces. It sees only what an allowlist binds: the system read-only, a named subset of `/etc`, its workspace (at its own path and at `/workspace`), its homes, and the model and egress sockets.
- **Checked before the spawn.** The argv is checked against that allowlist, and the box's first command against the kernel's forwarder on exactly the spec's sockets. A bind of a hidden path (serve's data root), or of anything that holds one, is refused.
- **Recorded before it runs.** The box's record is on disk before it is spawned, and its pid 1 before any harness process runs.
- **The reap answers by the kernel's count:** the box's cgroup, or the processes left in its pid namespace. An unreadable count is never empty.
- **The cgroup.** A box's cgroup sits strictly under the operator's delegated root, and one that already exists is refused. The server must start inside that delegated subtree, as systemd's `Delegate=yes` arranges: cgroup v2 lets a process move another only within a subtree they share, so a server moved in later can't put its boxes there. Such a start is refused by name.
- **`agentrun-box install`** is the operator's one root step on Ubuntu 24.04 and similar hosts. It loads the AppArmor profile bwrap needs where unprivileged user namespaces are restricted.
- **`probeBox`** checks a real box from inside, and fails closed when no box can be made.
