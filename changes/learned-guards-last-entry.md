---
packages: @parcha/agentrun-serve
kind: fix
---
A replay run's learned_workflow call that was rerun after a park and refused before any node ran no longer drops its earlier attempt's guard rows from the run's `metrics.guards`, which threshold refit and promotion replay read, and its timeline row keeps showing the earlier attempt's `learned_nodes` instead of none.
