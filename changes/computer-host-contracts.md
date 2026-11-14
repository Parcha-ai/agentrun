---
packages: @parcha/agentrun-computer
kind: feature
---
A vendor on the shared machine-host adapter writes less: `MachineHost.list` answers what the vendor's listing says, `stop` only asks, and `check` gets a spec that is already an object.
- `list(labels)` may leave out what the listing does not carry (the network, the vendor's drift) and may answer more machines than carry the labels. The adapter keeps the machines that carry every label, and reads `get` where it needs the rest: `list()`, attach by labels and a retried create. The live sweep keeps to the run's label the same way.
- Settings' test, where a host has none of its own, is one listing by the adapter's label, its computers counted with no read of each. E2B and Daytona drop their own.
- `stop(id)` answers once the vendor took the ask. The adapter then waits, bounded by `goneMs`, until `get` and the listing both read the machine stopped (or gone, where a stop deletes it: `stopDeletes`, or a GPU computer under `gpu.stopDeletes`), twice running. It asks again while the machine reads running, and a machine that reads failed ends the wait. Daytona's own wait is gone.
- `Machine.state` has `stopping`, a machine on its way to stopped. Daytona reads `stopping` and `pausing` as `stopping`, no longer as `stopped`.
- `check(spec)` is given an object whatever the caller passed (null, a string), so a host reads its fields with no check of its own.
