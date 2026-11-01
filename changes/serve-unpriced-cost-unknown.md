---
packages: @parcha/agentrun-serve
kind: fix
---
A pi run on a gateway model that has no price (an id pi-ai's catalog does not list, with no `AGENT_MODEL_PRICE` or tier price) now reads its cost as unknown, `cost.usd: null`, where it read a known $0. Each answer of such a model is written with no cost total, as a harness run's unpriced answer already was, so one such answer makes the run's cost unknown, a compaction's summary included. A model the catalog lists at $0, and a set price of `0,0`, stay a known $0. Priced models are unchanged.
