---
packages: @parcha/agentrun-dsl
kind: fix
---
`rederiveDecision` returns `null` for a route receipt with no branch answer and for a pick receipt with no pick answer, as its documentation says it does for a receipt that decided nothing. A route receipt without its branch answer and with an `unsure` rule made it throw a `TypeError`; without an `unsure` rule it returned a decision with an undefined branch. A pick receipt without its answer returned `{ index: -1, none: false }`. A receipt the interpreter records always carries its answer, so only a damaged or hand-built receipt changes.
