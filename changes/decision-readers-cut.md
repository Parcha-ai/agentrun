---
packages: @parcha/agentrun-serve
kind: breaking
---
Serve's file-era decision and run-database readers are gone: `decisionSpentIn`, `DECISION_COST` and `DECISION_HOLD` (cap.ts), `durableDecisions` (workflow/readers.ts) and all of run-db.ts (`readRunDbSync`, `observeRunDbOpens`, `runDbTestHooks`, `ChangedReadError`, `BehindReadError`, `MonotonicReads`); none was in the package's public entry point, and a workflow decision's spend is read from the runner's journal (`sessionSpendOf`), its receipts with `readDecisions` or `decisionsOverStore`.
