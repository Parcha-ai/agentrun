---
packages: @parcha/agentrun-serve
kind: docs
---
The README's "Spend cap" section no longer says a capped `claude-agent` or `codex` run cut mid-request refuses its next request: those runs also continue after a cut, at the worst case the cap held, as pi runs do.
