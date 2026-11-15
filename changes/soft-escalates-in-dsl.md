---
packages: @parcha/agentrun-dsl, @parcha/agentrun-serve
kind: feature
---
`softEscalates(doc)` in `@parcha/agentrun-dsl` names the escalates of a workflow document that read a judge's output, by label as a run names its step (`parent/child` in a child workflow): the ones a host that measures a check may pass to `WorkflowDeps.softEscalate`. What each node kind writes to the state is one table beside the interpreter's node runner, keyed by every kind, so a new kind says what it writes. An escalate whose `ask` predicate reads only a judge's fields (every `{path}` its `state` and `images` interpolate) is now one of them; an `ask` with no `state` reads the whole state and is not. AgentRun's replay uses it in place of its own copy of the walk.
