---
packages: @parcha/agentrun-computer
kind: breaking
---
A machine host that declares `HostFacts.labels.packed` no longer packs its labels: the shared adapter packs them at create, unpacks what `get` and `list` answer, and asks `list` for `PACKED_NAME` alone. Who breaks: a host that calls `packLabels` or `unpackLabels` itself. What to do: send `req.labels` to your API as they come, answer the labels your API keeps, and filter `list` by the labels it is given.
