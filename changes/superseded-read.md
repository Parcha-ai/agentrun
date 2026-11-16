---
packages: @parcha/agentrun-serve
kind: fix
---
Learning: a promotion record a beta.39 store holds as `decided: "superseded"` (a replay a newer draft cancelled) reads as `skipped` on beta.40, with `skipped_by` and a reason saying so, so the promotions list and its replay read show it decided and never "running". Nothing rewrites the stored record, and it never blocks a new draft's replay.
