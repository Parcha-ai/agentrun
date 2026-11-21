---
packages: @parcha/agentrun-serve
kind: fix
---
`DELETE /v2/runs/{id}` on a run whose launch named a caller's Archil disk now also deletes the agent's learning folder on that disk, together with the run's own folder. Before, the folder stayed until the agent's learning reset or the agent's delete, and the run's merge diff and its correction line stayed in it after the purge. Nothing reads that folder: a run on a named disk gets no learning seed.
