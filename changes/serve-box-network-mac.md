---
packages: @parcha/agentrun-serve, @parcha/pi-transport
kind: feature
---
On a Mac whose Docker runs in a VM (Docker Desktop, OrbStack or colima), a Docker box reaches the server's host list too, through one proxy container inside the VM. Linux keeps its own path, unchanged.
- The server runs the kernel's egress proxy in one container per server, `agentrun-egress-<12 hex>`, labelled `agentrun.egress`: `node:22-bookworm-slim` pinned by digest, the proxy's code bound read-only from the data root, the list as its one variable, a read-only root, no capability, the server's uid:gid. It listens on a Unix socket in a tmpfs volume owned by the server's uid, which the box mounts read-only at `/run/agentrun/egress/`. The box keeps `--network none`; the proxy container is the only container with a network, and it publishes no port.
- It turns on only when `docker info` names a VM runtime the server knows (`Docker Desktop`, `OrbStack`, or a colima host name), on a kernel that is not the Mac's. Anything else stays offline, with `network_reason` saying what was seen.
- At start the server sweeps the containers of its own label, pulls the image once if needed, starts the proxy and waits up to 10 s for it; until it is ready, or if it never is, the box's network is `none` with why. Docker restarts a proxy that dies, the server starts one that is gone again, and the server's stop removes it.
- pi-transport's `dockerBoxes` takes `volumes: [{ name, target, readOnly }]`, named volumes every box mounts with `--mount type=volume`.
