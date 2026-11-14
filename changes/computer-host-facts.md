---
packages: @parcha/agentrun-computer
kind: breaking
---
A vendor on the shared machine-host adapter states only its own facts: `HostedProvider` reads each kind's groups and GPUs from the host's descriptor too, and the adapter runs every step a vendor used to switch on (the size refusal, the session-bus close, the GPU record, the runtime check) the same way for each vendor. `capabilities()` is unchanged for E2B, Modal, Daytona and Agent37.
- Breaking: `HostDescriptor` adds `capabilities`, the provider's configurations. `HostedProvider` reads its kind's groups and GPUs from it, and refuses a `kind` the descriptor offers none of.
- Breaking: `HostFacts.gpu`, `gpuReadBack`, `vendorSockets`, `specFields`, `labelRules` and `runtime()` are gone. `labelRules` becomes `labels: { count, bytes }`, how many labels a machine carries and the bytes they come to (Modal 10 and 512, Agent37 4096 bytes), counted with the adapter's own labels as create gives them, at their longest.
- Agent37's check now prices names and values, as every vendor's is; its create still refuses metadata whose JSON passes 4096 bytes (invalid, before the POST).
- Breaking: `MachineRequest.network` (`"none" | "open"`) becomes `egress: boolean`, true only for an Archil computer's root; `workdir` is gone; `lifetimeMs` is always given; `cpus` and `memoryMb` are passed whenever the spec gives them, and `user` only to a host with `facts.user`.
- Breaking: `Machine.gpu` is gone. The adapter records a GPU computer's GPUs in the label `agentrun.computer.gpu` (`<type>:<count>`) at create and holds a retry and `attach()` to that label, for every vendor.
- Breaking: E2B and Daytona refuse `cpus` and `memoryMb` in their own check, in their words ("an E2B computer has the size of its template", "a Daytona computer has the size of its snapshot"); Modal and Agent37 take them as before.
- Modal's `check()` refuses labels past its 10 tags, counted with the adapter's own (five, and one each for a GPU or an Archil mount), with no call; `create` refuses the same words (refused) before any call.
- Breaking: every child host's create closes the session buses in `/tmp` (`/tmp/dbus-*`) to the computer's user before init starts, not Daytona's alone; the step's note appears only when it closed one.
- Breaking: a Daytona computer of a VM sandbox class is held to a VM runtime: a computer that reads back gVisor's kernel is refused, as a Modal or Agent37 one is.
