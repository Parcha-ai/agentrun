---
packages: @parcha/pi-durable-agent
kind: feature
---
A new `@parcha/pi-durable-agent/workflow` subpath runs an agent's workflow revision: `checkWorkflowBody` checks a revision's body before a store commits it, `runWorkflowRevision` runs its workflow with agentrun-pi's durable workflow task on the run's own store and returns the outcome and the `carryBack` input (`{ state, summary }`), and `readWorkflowRun` reads the run back, read-only. The package now depends on `@parcha/agentrun-dsl` and `@parcha/agentrun-pi`; only these functions load them, so an agent with no workflow revision never does.
