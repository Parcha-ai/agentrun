---
packages: @parcha/agentrun-serve
kind: ci
---
When the recovery test for a stop saved before its abort reached the run fails because the follow-up never completes, its failure message now carries the run's timeline, so a one-off failure in CI can be told apart from a run that never ended.
