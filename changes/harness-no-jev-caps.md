---
packages: @parcha/agentrun-harness
kind: breaking
---
The harness has no Jev cap. Every typed question is sent; `--max-usd` is the run's dollar stop, and TypeSafe rate-limits. `capJudge` and `JEV_CAPS` are gone from the package's exports: `priceJudge(runJudge)` prices an answer at Jev's list price as before. A demo.json that still sets `models.judge.caps` is refused at load: remove it.
