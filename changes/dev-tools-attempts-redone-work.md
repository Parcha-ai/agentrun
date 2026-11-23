---
packages: @parcha/agentrun-serve
kind: feature
---
The console's Dev tools tab says which attempt a cost line was made in, and what a run's repeated requests cost. Where an attempt at a turn was cut (its runner drained, crashed or lost its lease, or the turn was tried again) and another took the turn over, the model requests the cut one had sent and not finished were sent again. Each line of Cost by line then names its attempt, the repeated ones as "requests cut before they answered, sent again"; "Requests sent twice" under the split gives the server's own sum (`infra_usd` on `GET /runs/{id}/usage`) with its share of the run's cost, or "at most" that sum with no share where a line is a ceiling; and What stands out lists it after what failed. A run none of whose attempts was cut reads as before.
