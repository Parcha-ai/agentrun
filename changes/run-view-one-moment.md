---
packages: @parcha/agentrun-serve
kind: fix
---
A run's view (`GET /v2/runs/{id}`) and its timeline (`GET /v2/runs/{id}/timeline`) each read the store as it stood at one moment. A runner's write that landed while a view was built could show in part: a run read `working` with no result beside the cost of its end, and a timeline held rows from before an answer next to rows from after it. Status, result, cost, pending approval and rows now all come from the same snapshot.
Upgrading: nothing to do.
