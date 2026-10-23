---
packages: @parcha/pi-durable-agent, @parcha/agentrun-pi
kind: feature
---
A new `@parcha/pi-durable-agent/workflow` subpath runs an agent's workflow revision: `checkWorkflowBody` checks a revision's body before a store commits it, `runWorkflowRevision` runs its workflow with agentrun-pi's durable workflow task on the run's own store and returns the outcome and the `carryBack` input (`{ state, summary }`), `readWorkflowRun` reads the run back, read-only, and `revisionGraph` draws a revision's graph and its diff from a workflow parent. The package now depends on `@parcha/agentrun-dsl` and `@parcha/agentrun-pi`; only these functions load them, so an agent with no workflow revision never does.
agentrun-pi's readers `readJournal` and `durableDoc` take a new option, `{ immutable: true }`, which opens a store no process writes any more (an ended run's, with no write-ahead log beside it) as an immutable file, so the read makes no file beside it.
