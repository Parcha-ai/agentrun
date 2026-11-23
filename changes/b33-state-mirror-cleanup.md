---
packages: @parcha/agentrun-harness-acp, @parcha/agentrun-serve
kind: fix
---
`@parcha/agentrun-harness-acp` no longer exports `STATE_BUDGET` or `stateBudgetPassed`; only its own tests read them. `FrameTooLarge` is a plain named `RangeError`: its message still names the size and the limit, and it no longer carries them as `bytes` and `limit` fields.
