---
packages: @parcha/pi-durable-disk
kind: feature
---
New export `archilControl({ apiKey, disk, region })`: one Archil disk's control API (S3 reads and writes, delegations, token users, `listUsers`), the object `ensureRunning`, `superviseRuns`, `checkHost`, `fork` and the token janitor take as `control`. A library caller composing its own supervisor, such as one driving `daytonaHost`, which `supervise` does not start, builds it without depending on the `disk` client. It is the CLI's own builder, moved and exported; `supervise` now calls it, so both get the same object. Additive.
