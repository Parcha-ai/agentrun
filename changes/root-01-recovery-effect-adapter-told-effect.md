---
packages: repo
kind: feature
---
`@parcha/agentrun-dsl/recovery`: the host's effect adapter is told the admitted effect. Under the driver, `runEffect` receives `effect: { id, argsHash }` (typed on `RecoveryEffectParams`, beside `call`): the effect's journal id and the hash of its arguments, as `journal.admit` stored them and the same in every process of the run. A host that keeps what an outside call answered under them settles an effect whose call was cut with `journal.complete`, without recomputing the driver's hash. Additive; the journal's stored format is unchanged.
