---
packages: @parcha/agentrun-computer
kind: breaking
---
Remote computers (Daytona, E2B, Modal) cut the daemon's programs off from the vendor's own agent in the sandbox (Daytona's toolbox on 2280, E2B's envd on 49983), which runs commands as root or with sudo for whoever reaches it. Each starts `computerd init --user <uid:gid> --own-network`. Init, still root, does four things: it refuses uid 0 for its programs; it refuses to start while another process holds their uid; it moves into a network namespace that holds its loopback alone; and once dropped, it refuses AF_VSOCK sockets and io_uring_setup on every thread. Without CAP_SYS_ADMIN and CAP_NET_ADMIN, init refuses to start in words and the computer fails closed.

Who breaks, and what to do:
- A Daytona, E2B or Modal spec with network `open` or an allowlist is refused in words by `check()` and `create()`, and `network()` refuses a change to one. Ask for `none`. A proxy-backed open network on remote computers is the next feature after this one.
- E2B's `publicStream` option (and `COMPUTER_E2B_PUBLIC_STREAM=1`) throws in words, so no E2B provider has `stream()` for now.
- The default computer user on Daytona, E2B and Modal is 2510:2510 (was 1000:1000). The `daemonUser` and `user` options still name another one.
- `capabilities().vendorAgentPorts` declares the ports of a vendor's agent: Daytona `[2280]`, E2B `[49983]`, Modal `[]`. The new Core conformance case `isolation.vendor-agent` probes them as the computer's user and requires every one refused, with the loopback alone in view. A provider with daemon `child` must declare the ports.
- `computerd probe` reports `interfaces`. The Daytona and E2B drift checks require the daemon's network to hold `lo` alone and its seccomp mode to be 2. Modal's probe requires `interfaces` to read `["lo"]`.
