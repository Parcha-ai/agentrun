---
packages: @parcha/agentrun-serve
kind: fix
---
Rebuild persisted run-list rows from older releases when they lack the current path or workflow
fields, even when the run and saved secrets have not changed. Global and agent-specific lists now
agree with individual run details after an upgrade. Explicit null values remain valid cached data.
