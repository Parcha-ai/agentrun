---
packages: repo
kind: fix
---
Every node of a workflow run by the reference host thinks: its own `thinking` level, else `low` (the DSL runner's default), never pi-durable's `off`.
