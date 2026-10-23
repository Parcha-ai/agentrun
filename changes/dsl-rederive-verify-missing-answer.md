---
packages: @parcha/agentrun-dsl
kind: fix
---
`rederiveDecision` returns `null` for a `verify` receipt whose rule has a field with a threshold but no yes/no answer for it, as it already does for a receipt that decided nothing. Before, a missing answer read as `NaN`, which is not below the threshold, so the field was skipped and the receipt re-derived as `{ accepted: true }` — accepting where the live run, which scores a missing answer as 0, would have doubted or unmet it. A field whose threshold is `null` (held empty and not judged) needs no answer and is unchanged. A receipt the interpreter recorded carries every answer, so only a damaged or hand-built receipt changes.
