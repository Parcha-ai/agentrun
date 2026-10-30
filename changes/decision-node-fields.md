---
packages: @parcha/agentrun-dsl
kind: feature
---
**Decision nodes name their provider, pin their model, ask for evidence and bound their own time**
- `judge`, `pick`, `sift`, a judged `route` and an `ask` predicate take optional `provider`, `model`, `evidence` (`"off"`, `"if_supported"` or `"required"`) and `timeoutMs` (1 to 120000). A route by value takes none of them.
- `judgeFromProviders({ providers, default, deadlineMs })` is the interpreter's `runJudge` over several providers: each request goes to its node's provider, or the default, with its pinned model, within the shorter of the node's `timeoutMs` and the provider's deadline. A node only ever shortens it. A call its node's bound cuts is `outcome_unknown`: never asked again, and the run escalates as `decision_interrupted`.
- With `decisionProviders: { providers, default }` in its deps, a run checks every decision node before any node runs: a provider the host lacks, `"required"` evidence from a provider that gives none, or a question type it does not answer stops the run naming the node.
- The provider's evidence (`{ url, title, excerpts, scope }`) travels with the answer to the `<as>$answers` sidecar, the decision receipt and the node's answered event; `"off"` drops it, and `"required"` with none fails the decision. Receipts name the provider that answered.
- A pinned `provider` or `model` is part of the decision id, so changing it asks the decision again. A node that pins neither keeps the id it had.
- A decision whose outcome was lost (`outcome_unknown`) is booked with the provider's `cost_basis` beside its cost: the exchange `recordDecision` gets carries both.
- `dryRunWorkflow` passes a node whose `evidence` is `"required"`: its synthetic answer carries a placeholder source.
