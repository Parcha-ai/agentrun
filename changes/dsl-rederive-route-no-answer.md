---
packages: @parcha/agentrun-dsl
kind: fix
---
`rederiveDecision` returns `null` for a route receipt that has no branch answer, as its documentation says it does for a receipt that decided nothing. Such a receipt with an `unsure` rule made it throw a `TypeError`; one without an `unsure` rule returned a decision with an undefined branch. A receipt the interpreter records always carries the branch answer, so only a damaged or hand-built receipt changes.
