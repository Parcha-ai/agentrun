---
packages: @parcha/agentrun-serve
kind: feature
---
The console's Dev tools tab says which attempt a cost line was made in, and what redone work cost. Where an attempt at a turn was cut (its runner drained, crashed or lost its lease, or the turn was tried again) and another attempt worked the turn again, each line of Cost by line names its attempt, the cut one as "cut and worked again"; "Redone work" under the split gives the server's own sum (`infra_usd` on `GET /runs/{id}/usage`) with its share of the run's cost; and What stands out lists it after what failed. A run none of whose attempts was cut reads as before.
