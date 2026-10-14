---
packages: @parcha/pi-durable-disk
kind: fix
---
`@parcha/pi-durable-disk/lease` exports the four types its own signatures name: `AcquireOptions`, `PersistRecord` and `ClaimDir` (in `OpenRunLeaseOptions`) and `Unmounted` (in `Claim`). A host that imports only this entry can now write the type of every option it passes to `openRunLease`. They are type-only exports, so the entry's bundle still leaves out the supervisor, the host drivers, the CLI and the app contract. A test checks that every type of the package the entry's declarations name is exported by the entry.
