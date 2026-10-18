---
packages: repo
kind: feature
---
A box billed per call (RECORDING.md draft 40) is checked and priced (`apps/viewer`, `scripts/recording`). Its `box.receipt` carries `calls` and `usd_per_call` in place of `usd_per_second`, and its `cost_usd` is `calls` times `usd_per_call`; the counter strip sums it into the boxes' part like any receipt, at list price, and a per-call box with no published price makes the cost unknown, never 0. Both validators, the viewer's `validate` and `scripts/recording/validate.mjs`, now check every receipt by one rule, `boxReceiptProblems` in `apps/viewer/src/box-receipt.ts`: they refuse a receipt with both `usd_per_second` and `usd_per_call`, `calls` without `usd_per_call` or the reverse, a receipt with no price, and a `cost_usd` that is not its price times its `seconds` or `calls` to 9 decimals; an unpriced box's `null` price and `null` cost pass. Every receipt in the recordings published so far passes.
