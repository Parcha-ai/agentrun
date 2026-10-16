---
packages: repo
kind: feature
---
The supervisor writes `delegation` host lines from `place.status()`'s `delegations` when one appears or its orphaned or pending state changes, and a `revoke` line from `recover()`'s `{ revoked, ms }`; a place without them writes none.
The supervisor writes a `box.receipt` host line for each box `place.status().boxes` reports once its `to` appears (or at the final read): the box as a `box-N` label, seconds, the published per-second price and the cost (null with no price), the source and whether it was priced; never the provider's id. A place that reports none writes none.
The example's cost (`examples/reference/fold.ts`) counts each `box.receipt`'s `cost_usd` once per box label; a receipt with none (an unpriced box, or one still open at the final read) makes the cost unknown, never 0.
