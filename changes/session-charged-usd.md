---
packages: @parcha/agentrun-kernel
kind: feature
---
`sessionSpendOf` also answers `chargedUsd`: what a session's answered requests were charged, a request a crash cut counted at its hold, and never one still in flight at its hold (null when one answered has no figure). `spentUsd` is unchanged and still counts the open ones at their holds. A host that checks a run's cap once it has settled reads `chargedUsd` in place of summing `figures` itself.
