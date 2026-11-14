---
packages: @parcha/agentrun-computer
kind: breaking
---
A `MachineHost` has twelve members: `descriptor`, `facts`, `create`, `get`, `list`, `delete` and `exec`, then the optional `upload`, `errorCode`, `stop`, `extend` and `check`. A provider's mounts and capabilities live in its descriptor alone. Who breaks: a host written against `MachineHost`, and code that imports a removed export. What to do, for each:
- `MachineHost.prepare` is gone. No host implemented it; delete it from yours.
- `MachineHost.testConnection` is gone. Settings' test of a host's keys is one `list` by AgentRun's label, so a `list` must create nothing (Modal's no longer makes its app).
- `MachineHost.setTimer` and `setLabels` are one optional `extend(id, endsAt, ctx)`: move the vendor's timer (`lifetime: "vendor"`) or AgentRun's deadline label (`"janitor"`). AgentRun reads the end back through `get`.
- `MachineHost.id` is `MachineHost.descriptor`: set it to your descriptor (`readonly descriptor = E2B`). `HostFacts.network`, `mounts` and `unmounted`, `HostFacts.labelRules.key` and `HostedOptions.label` are gone: the adapter reads them from the descriptor.
- `hostedProvider(host, options)` is gone: use `new HostedProvider(host, options)`.
- The `MOUNT` and `CAPABILITIES` exports of every provider module, and those fields of `ProviderModule`, are gone: read `descriptorOf(id).mounts` and `.capabilities`.
- `@parcha/agentrun-computer/agent37` no longer re-exports the ssh2 slice types (`Ssh2Channel`, `Ssh2Client`, `Ssh2ConnectConfig`, `Ssh2Module`, `Ssh2Readable`), and `Agent37Error` and `Agent37TunnelError` are gone: a tunnel failure is an `SshTunnelError`, and a REST failure is the `Result` the host answers.
- `src/hosted/ssh.ts` is `src/agent37-ssh.ts`, Agent37's own; it was never a package subpath.
- `allPages`'s `next` answers a cursor string only, no longer `true`.
