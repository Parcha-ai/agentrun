---
packages: @parcha/agentrun-harness
kind: fix
---
`cost()` rounds every figure once to 1e-8 dollars, so a sum of many small prices no longer carries float noise (a live run printed `$0.8724838500000002`) and sub-cent precision stays. The summary, `--json` and the manifest agree. The summary prints cents at or above one cent (`$0.87`) and two significant digits below it (`$0.0035`).
