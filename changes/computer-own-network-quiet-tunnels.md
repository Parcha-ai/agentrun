---
packages: @parcha/agentrun-computer
kind: fix
---
A remote computer starts on a kernel with the tunnel modules loaded (Modal's VM), where every new network namespace gets the kernel's fallback tunnels (tunl0, gre0, sit0 and the rest), down with no address. Init's own network now holds the loopback alone up or addressed, every other interface down with no address, in place of the loopback alone; no sysctl is written.
- `computerd probe` reports `interfaces` as the live ones (up or addressed) alone, plus `quiet` (down, no address) and `raised` (any quiet one it could bring up as its user, put back after). No program of a computer's holds CAP_NET_ADMIN, so `raised` is empty.
- Daytona's, E2B's and Modal's read-backs of a computer's own network, and the conformance case `isolation.vendor-agent`, read that report through computerd's probe instead of `/proc/self/net/dev`. A raised interface is drift; quiet ones are recorded, never drift.
