---
packages: @parcha/agentrun-serve
kind: feature
---
A learned workflow's check now judges each answer field on its own, against the best known answer that field has: a label, else a stored grade's expected answer, else the agent's own answer. The workflow serves only when every field is within the margin (2 points by default) of the agent on the same inputs. A hold names the fields that failed and the inputs each got wrong, and the revise prompt passes that on, so a workflow that is right on one field and wrong on another is told which.
Grades' `expected` answers are compared for the first time; before, a check read the agent's answers alone. The check record gains `check.fields` (per field: inputs, right by workflow, right by agent, which known answer, pass), and each disagreement gains `fields`.
