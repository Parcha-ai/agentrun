---
packages: @parcha/agentrun-computer
kind: breaking
---
A vendor on the shared machine-host adapter states only its own facts: `HostedProvider` reads each kind's groups and GPUs from the host's descriptor too, and the adapter runs every step a vendor used to switch on (the size refusal, the session-bus close, the GPU record, the runtime check) the same way for each vendor. `capabilities()` is unchanged for E2B, Modal, Daytona and Agent37.
- Breaking: `HostDescriptor` adds `capabilities`, the provider's configurations. `HostedProvider` reads its kind's groups and GPUs from it, and refuses a `kind` the descriptor offers none of.
- Breaking: `HostFacts.gpu`, `gpuReadBack`, `vendorSockets`, `specFields`, `labelRules` and `runtime()` are gone. `labelRules` becomes `labelBytes`, the one number of bytes a machine's labels come to (Modal 512, Agent37 4096), priced with the adapter's own labels at their longest.
- Agent37's check now prices names and values, as every vendor's is; its create still refuses metadata whose JSON passes 4096 bytes (invalid, before the POST).
- Breaking: `MachineRequest.network` (`"none" | "open"`) becomes `egress: boolean`, true only for an Archil computer's root; `workdir` is gone; `lifetimeMs` is always given; `cpus` and `memoryMb` are passed whenever the spec gives them, and `user` only to a host with `facts.user`.
- Breaking: `Machine.gpu` is gone. The adapter records a GPU computer's GPUs in the label `agentrun.computer.gpu` (`<type>:<count>`) at create and holds a retry and `attach()` to that label, for every vendor.
- Breaking: E2B and Daytona refuse `cpus` and `memoryMb` in their own check, in their words ("an E2B computer has the size of its template", "a Daytona computer has the size of its snapshot"); Modal and Agent37 take them as before.
- Breaking: Modal refuses more than 10 labels at create (invalid, before any sandbox is made), not at check: its 10 tags are counted with the adapter's own.
- Breaking: every child host's create closes the session buses in `/tmp` (`/tmp/dbus-*`) to the computer's user before init starts, not Daytona's alone; the step's note appears only when it closed one.
- Breaking: a Daytona computer of a VM sandbox class is held to a VM runtime: a computer that reads back gVisor's kernel is refused, as a Modal or Agent37 one is.
