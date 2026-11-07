---
packages: @parcha/agentrun-serve
kind: fix
---
A spend cap's wrap-up no longer tells a run to wrap up before it has done anything on a common cap. While nothing is priced, the typical request it is measured against is the next request at its input and a 4,096-token answer, not its whole output allowance: a $1 run on Claude Sonnet 4.5 was told at its start (its 64,000-token allowance alone is $0.96), and now is not. A note that comes due while nothing is priced says the budget ("This run's budget is about $X, enough for little work: answer as soon as you can.") on claude-agent, codex and opencode too, as on pi, never "finish now".
