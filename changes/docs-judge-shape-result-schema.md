---
packages: @parcha/pi-agent-learn, @parcha/agentrun-pi
kind: docs
---
Two notes for host authors. The `pi-agent-learn` README says how a judge on a general model, rather than Jev, answers
curate's questions: ask for `{ answer, confidence }` and derive the yes-probability, since a model asked for a bare
probability reads it as its confidence. The host integration guide says to give each tool a workflow calls through
`createWorkflowTool` a `resultSchema`: without one, `describe` reports pi's result envelope and the result reaches the
next node untyped.
