---
packages: @parcha/agentrun-dsl
kind: breaking
---
Exports that nothing calls are removed. Who breaks: code that imports one of them. From `@parcha/agentrun-dsl/recovery`: `buildHandoff`, `handoffFirstTurn`, `inheritableReceipts`, `inheritableUnknowns`, `inputProvenance`, `judgedRecords`, `TypedEffectFailure`, `EffectEnvelopeFailure`, `classifyEffectFailure`, `heldCallKey`, and the types `Handoff`, `HandoffOptions`, `InputProvenance`, `InheritedSession`, `InheritedEffect` and `TranscriptMessage`. From `@parcha/agentrun-dsl`: `buildReferenceContext`, `parseCsvRows` and `terminalArtifactType`. Nothing replaces them. Copy the function from an earlier version if you need it.
