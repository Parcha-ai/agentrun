---
packages: @parcha/agentrun-computer
kind: docs
---
`PROVIDERS.md` tells a provider author in minute one whether and how their vendor fits: the exec shapes that work (a native stream, SSH, an SDK-only exec, a relay in the image, or no exec and daemon `none`), with the five rules every one keeps and the two shapes that can't carry the daemon today.
- Network: on a vendor whose root can make a network namespace, `none`, `open` and a list are AgentRun's own (init's fence and egress proxy); a vendor policy is optional hardening.
- `daemon: "child"` means the vendor starts AgentRun's processes through its exec, and `vendorAgentPorts: []` is right when no vendor agent listens on TCP.
- Lifetime: switch off vendor idle stops, measure an undocumented cap, and leave `extend` out where what it moves is fixed at create.
- `get` never wakes a machine, a deleted one stays gone, and a table maps odd vendor states; hosted providers never declare `persistence`.
- A worked multi-key descriptor (Modal's), how `COMPUTER_<VENDOR>_*` maps to it, and the first 30 minutes by vendor shape.
- `spec/computer/provider.md`, `kinds.md` and `stdio.md` say the same, and a desktop with no vendor stream gives its live view through the daemon.
