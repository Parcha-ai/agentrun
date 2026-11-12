---
packages: @parcha/agentrun-serve
kind: breaking
---
A workflow run's decision receipts are read and written only in the keyed form (one `agentrun.decisions` document per receipt, with `agentrun.decisions.count`). The old single-document form, where one `agentrun.decisions` document held a `receipts` list, is no longer read or continued: a run store written in it shows no decisions. Nothing writes that form any more, so an upgrader with such a store has nothing to do but start new runs. Also gone, with no caller left: the decision writer (`createDecisionWriter`), `committedRoutes`, `lintRecordSchema`, `resultBlocks` and `ToolResultKeyError`, `toolRefusal`, the per-run door-token names in `files.ts`, and a set of unused imports and locals in `server.ts` and the runner.
