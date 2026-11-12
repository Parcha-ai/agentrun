---
packages: @parcha/agentrun-dsl
kind: breaking
---
The dsl no longer exports names whose only users were the retired pi packages: from the root `candidatePolicyErrors`, `AUTHOR_SKILL_NAME` and `WORKFLOW_NODE_KINDS`; from `@parcha/agentrun-dsl/recovery` `canonicalJson`, `frozenEffectId`, `frozenEffectPath`, `frozenStepSessionId`, `gatewayIntentOf`, `returnedFailure`, `InheritedReceipt` and `InheritedUnknown`, and the driver's `handoff` and `annotateHandoff` methods. A caller of any of them drops it (`authorWorkflow` still runs the candidate check).
