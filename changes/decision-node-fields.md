---
packages: @parcha/agentrun-dsl, @parcha/agentrun-decisions, @parcha/agentrun-pi
kind: feature
---
**Decision nodes name their provider, pin their model, ask for evidence and bound their own time**
- `judge`, `pick`, `sift`, a judged `route` and an `ask` predicate take optional `provider`, `model`, `evidence` (`"off"`, `"if_supported"` or `"required"`) and `timeoutMs` (1 to 120000). A route by value takes none of them.
- `judgeFromProviders({ providers, default, deadlineMs })` is the interpreter's `runJudge` over several providers: each request goes to its node's provider, or the default, with its pinned model, within the shorter of the node's `timeoutMs` and the provider's deadline. A node only ever shortens it. A call its node's bound cuts is `outcome_unknown`: never asked again, and the run escalates as `decision_interrupted`.
- With `decisionProviders: { providers, default }` in its deps, a run checks every decision node before any node runs: a provider the host lacks, `"required"` evidence from a provider that gives none, a model it does not serve, or a question type it does not answer stops the run naming the node. A provider is looked up by own property only, so a name such as `"constructor"` is a provider the host lacks, in the check and in `judgeFromProviders`.
- Without `decisionProviders`, a run refuses before any node runs a node that names a provider or sets `timeoutMs`: the host's judge could honour neither. `dryRunWorkflow` holds a node to no host's providers.
- `DecisionCapabilities` takes an optional `models`, the names a node may pin (absent or null: any). A pin outside them is refused before any node runs, and `checkCapabilities` refuses it as `invalid_request` before a provider sends anything. `parallelProvider()` declares `parallel-fast`, the one mode it asks.
- Pi's Jev judge is `judgeFromProviders` over a Jev-only registry, which the run's checks get too: a node naming another provider is refused before the run, with nothing sent to Jev, and a node's `timeoutMs` bounds its request.
- The provider's evidence (`{ url, title, excerpts, scope }`) travels with the answer to the `<as>$answers` sidecar, the decision receipt and the node's answered event; `"off"` drops it, and `"required"` with none fails the decision. Receipts name the provider that answered. A `sift` gives each item's sidecar the evidence of the request that answered it, and its answered event names the provider and every request's evidence.
- A pinned `provider` or `model` is part of the decision id, so changing it asks the decision again. A node that pins neither keeps the id it had.
- A decision whose outcome was lost (`outcome_unknown`) is booked with the provider's `cost_basis` beside its cost: the exchange `recordDecision` gets carries both.
- `dryRunWorkflow` passes a node whose `evidence` is `"required"`: its synthetic answer carries a placeholder source.
