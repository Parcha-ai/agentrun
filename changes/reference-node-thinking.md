---
packages: repo
kind: fix
---
Every node of a workflow run by the reference host thinks: its own `thinking` level, else `low` (the DSL runner's default), never `off` (a node that carries `off` runs at `low`).
