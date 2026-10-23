---
packages: @parcha/pi-durable-agent
kind: feature
---
A run can be pinned to a revision's verified body: the run is seeded from the revision's instructions, tools and skill files (each checked against its SHA-256), never from the home's definition, and its record names the revision and its kind. `carryBack` can also store a one-line `summary` on the run's record. A run started the free way (`startRun`) is unchanged, and so is its record.
