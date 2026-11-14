---
packages: @parcha/agentrun-computer
kind: breaking
---
A vendor on the shared machine-host adapter states only its own facts: `HostedProvider` reads the network forms, mount kinds and each kind's groups and GPUs from the provider's descriptor, and the adapter runs every step a vendor used to switch on (the size refusal, the session-bus close, the GPU record, the runtime check) the same way for each vendor. `capabilities()` is unchanged for E2B, Modal, Daytona and Agent37.
- Breaking: `HostedOptions.label` is replaced by `descriptor`, the provider's descriptor (`HostedDescriptor`: its id, label, network, mounts, unmounted and capabilities). The descriptor's id must be the host's, and `kind` must be one of its capabilities.
- Breaking: `HostFacts.network`, `mounts`, `unmounted`, `gpu`, `gpuReadBack`, `vendorSockets`, `specFields`, `labelRules` and `runtime()` are gone. `labelRules` becomes `labelBytes`, the one number of bytes a machine's labels come to (Modal 512, Agent37 4096), priced with the adapter's own labels at their longest.
- Breaking: `MachineHost.setTimer` and `setLabels` fold into one optional `extend(id, endsAt, ctx)`: E2B moves its timer up to the computer's max-deadline label, and Agent37 writes its deadline label itself.
- Breaking: `MachineRequest.network` (`"none" | "open"`) becomes `egress: boolean`, true only for an Archil computer's root; `workdir` is gone; `lifetimeMs` is always given; `cpus` and `memoryMb` are passed whenever the spec gives them, and `user` only to a host with `facts.user`.
- Breaking: `Machine.gpu` is gone. The adapter records a GPU computer's GPUs in the label `agentrun.computer.gpu` (`<type>:<count>`) at create and holds a retry and `attach()` to that label, for every vendor.
- Breaking: E2B and Daytona refuse `cpus` and `memoryMb` in their own check, in their words ("an E2B computer has the size of its template", "a Daytona computer has the size of its snapshot"); Modal and Agent37 take them as before.
- Breaking: Modal refuses more than 10 labels at create (invalid, before any sandbox is made), not at check: its 10 tags are counted with the adapter's own.
- Breaking: every child host's create closes the session buses in `/tmp` (`/tmp/dbus-*`) to the computer's user before init starts, not Daytona's alone; the step's note appears only when it closed one.
- Breaking: a Daytona computer of a VM sandbox class is held to a VM runtime: a computer that reads back gVisor's kernel is refused, as a Modal or Agent37 one is.
