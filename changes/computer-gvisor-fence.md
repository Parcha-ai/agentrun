---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
The loopback fence now holds on gVisor, so Modal GPU computers can start. Root there has no CAP_SYS_ADMIN, so `computerd init --own-network` couldn't make its programs' network namespace.
- Init still tries the plain network namespace first. On EPERM alone, it makes the same namespace inside a user namespace instead, whatever the vendor.
  - It starts itself again as `computerd userns-init`, in a user namespace that maps every uid and gid to itself. Files and the run's folder keep their owners.
  - The first init stays PID 1 with no capability, passes SIGTERM and SIGINT on, and ends with the init it started.
  - If neither way works, init refuses to start in words that name both.
- Init brings the loopback up over rtnetlink alone (RTM_NEWLINK on lo's index, plus RTM_NEWADDR for 127.0.0.1/8 where the kernel gave none). The SIOCSIFFLAGS ioctl is gone: gVisor's netstack refuses it in a new namespace (ENOTTY). Init then reads back lo up and running, 127.0.0.1 on it, and a listener there reached. computerd's probe tries to raise an interface the same way.
- `hello` reports which fence holds: `fence: "netns" | "userns-netns"` (`NetworkFence`, `NETWORK_FENCES`). Every provider that starts init with `--own-network` refuses a hello that names neither: Daytona, E2B, Orgo and Modal.
- Modal declares `gpu.fence: "userns-netns"`. Its create notes the fence when it is `userns-netns`, and a conformance report's `daemon.fence` records it. `GET /v2/computers` shows the GPU's `fence`.
