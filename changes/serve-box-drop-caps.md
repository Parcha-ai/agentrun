---
packages: @parcha/pi-transport, @parcha/agentrun-serve
kind: fix
---
A run's Docker box drops every capability, and a Docker daemon on another machine never binds this machine's `work/`.
- `dockerBoxes({ dropCapabilities: true })` runs each box with `--cap-drop ALL` and `--security-opt no-new-privileges`. Serve's run boxes always use it. Without it, a server run as uid 0 made boxes that were root with Docker's default capabilities, so `bash` could `mknod` a device node in `work/` (`c 10 130`, the watchdog) for the file tools on the host to open. The option is off by default in pi-transport, because a launcher that drops from root to another user needs Docker's default set.
- `dockerBoxes`' `mounts` is now false when `DOCKER_HOST`, or the docker context (`DOCKER_CONTEXT`, else the config's `currentContext`), names a daemon on another machine (tcp://, ssh://, or a context whose record names no unix socket). A spec with mounts is then refused as `unsupported`, naming the setting and how to undo it. In serve, a run's box on such a daemon is not bound, so `read`, `write` and `edit` go through the box, never this machine's `work/`.
