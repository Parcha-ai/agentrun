---
packages: @parcha/agentrun-harness
kind: fix
---
**A judge answer with no price and no usage keeps its cost unknown**
- `priceJudge` prices an answer at Jev's list price only when it reports usage and no price of its own. An answer that reports neither now keeps no price, so the run's cost reads it as unknown. Before, it was priced at $0.
