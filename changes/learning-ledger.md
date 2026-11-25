---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
Learning cost has one source, a ledger of a row per run and a spend row per compile, check and audit. The cost page, `GET /runs/{id}` and the money rule read it.
- New fields: `cost` and `runs[]` gain `compile_usd`, `followup_usd`, `shadow_usd` and `share_usd`; `runs[]` gains `not_served`. `runs[].learning_usd` holds the run's own compile turns; a run read's holds its share instead.
- The money rule's by-hand side is the job's own cost over the newest 500 runs, or the 10 by hand before them. A served run cut at its cap counts at its bound. With no by-hand cost, or unreadable runs, the agent takes the run.
- `/stats` counts a run whose shadow is at work or unpriced as unknown cost.
- Postgres applies migration 0028 (additive); SQLite adds the tables at start.
