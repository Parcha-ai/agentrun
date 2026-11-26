---
packages: @parcha/agentrun-serve
kind: fix
---
`DELETE /runs/{id}` empties an SDK start pinned before the learning-rows upgrade only when that start belongs to the purged run's agent. Before, a run's purge emptied every such inbox on the server, including other agents' and other tenants'. Those receipts already answer `409 not_continuable`, so nothing was disclosed; the purge now writes only its own agent's rows.
