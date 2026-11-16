---
packages: @parcha/agentrun-computer
kind: breaking
---
The machine-host label and lifetime mechanisms are cut back to what the reference providers use: `HostFacts.backstop`, the Core case `provider.backstop`, `HostFacts.idleMs` and the host member `keepalive` are gone, the shared adapter now packs labels itself, and a host with `labels: "machine"` must declare `lifetime: "vendor"` and have no `extend`. Who breaks: a host that declares any of these, or packs its own labels. What to do:
- `backstop: true`: delete it. A janitor host still sets its vendor's delete timer from `req.backstopAt`, which stays, and `get` still reads it as `Machine.endsAt`.
- `idleMs` and `keepalive`: delete them, and switch off every vendor timer that ends a quiet machine. Where that can't be done, the vendor doesn't fit yet.
- `labels.packed`: stop calling `packLabels` and `unpackLabels`. Send `req.labels` to your API as they come, answer the labels it keeps, and filter `list` by the labels it is given. The adapter packs at create, unpacks what `get` and `list` answer, and asks `list` for `PACKED_NAME` alone.
- `labels: "machine"`: declare `lifetime: "vendor"` and leave `extend` out. The provider refuses either, in words.

With `labels: "machine"`, each read of a machine's label file is bounded by the request timeout. A read that fails or doesn't end leaves that machine out of that listing, told through `onNote` (and in the sweep's words) with its id and why, and the listing goes on. A create's listing by its name fails instead, since the machine may be its own.
