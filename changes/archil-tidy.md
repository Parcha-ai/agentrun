---
packages: @parcha/agentrun-serve
kind: fix
---
An Archil disk that Archil reads as `deleted` is gone, as one it has no record of is: an agent's disk refuses the claim with the way out (`DELETE /v2/agents/{id}/archil`; the next run makes a new disk), where it read "not ready" with none, and a launch's disk is refused at the launch (422), where it was taken. A reclaimed run's first exec no longer puts the run's folder again, so a kept computer that holds the folder doesn't stall it.
