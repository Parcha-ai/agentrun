---
packages: @parcha/pi-agent-learn
kind: feature
---
New held package `@parcha/pi-agent-learn`: an agent that learns in its own git repository, on top of
`@parcha/pi-git-remote`. This first part holds the contract a guard implements (`Guard`, `GuardInput`, `Refusal`) and the
types a `learn` call records (`Candidate`, `LEARN_TYPES`, `ENTRY_TYPES`).
