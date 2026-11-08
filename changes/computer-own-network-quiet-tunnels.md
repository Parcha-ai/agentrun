---
packages: @parcha/agentrun-computer
kind: fix
---
A remote computer starts on a kernel with the tunnel modules loaded (Modal's VM), where every new network namespace gets the kernel's fallback tunnels (tunl0, gre0, sit0 and the rest), down with no address. Init's own network now holds the loopback alone up or addressed, every other interface down with no address, in place of the loopback alone; no sysctl is written.
- `computerd probe` reports `interfaces` as the live ones (up or addressed) alone, plus `quiet` (down, no address) and `raised` (any quiet one it could bring up as its user, put back after). No program of a computer's holds CAP_NET_ADMIN, so `raised` is empty.
- Daytona's, E2B's and Modal's read-backs of a computer's own network, and the conformance case `isolation.vendor-agent`, read that report through computerd's probe instead of `/proc/self/net/dev`. A raised interface is drift; quiet ones are recorded, never drift.
- `computerd probe --sockets` also lists the unix sockets with a path the probe can connect to (`sockets`, by real path: a bounded walk of /run, /tmp and the like, and /proc/net/unix's paths). `isolation.vendor-agent` holds them to the computer's own (computerd's, the Archil sync socket, and on a desktop the one X socket of its display), and a probe with no list fails it; no image needs python3.
- A desktop's `hello` says the display it drives (`display`, such as `":99"`). The isolation check reads it there: the daemon's `/proc/self/environ` is root's once init drops to its programs' uid.
