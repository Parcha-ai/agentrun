---
packages: repo
kind: feature
---
**`apps/viewer`: box time in the run's cost, and a scripted run's real parts on the strip (RECORDING.md drafts 33, 35, 36)**
- The cost sums each `box.receipt` host line's `cost_usd`, once per box by its label, and labels it at list price:
  `$0.0147 (boxes $0.0047 at list price)`. A restore keeps it: a box's time was spent whatever the store went back to.
- The cost is unknown while a box pi-transport's own lines show started (`box.created`) has no receipt of its own
  (source `transport`), when a receipt's `cost_usd` is null (a kind with no published price), and, as before, when the
  recording has no durable line. Started boxes named by label (`box-N`, as a receipt names its box) are matched to their
  own receipts; ones named by the provider's id, which no receipt carries, are counted against the transport receipts.
- A scripted run whose boxes cost something reads `scripted lead, boxes $0.0047 at list price`, its other parts named
  scripted with their sum when they priced anything, never `scripted, $0`. A scripted run with no box, or whose boxes
  cost nothing, reads as before.
- The counters carry `costParts`, the cost by part (`lead`, `judge`, `eyes`, `browser`, `boxes`), and `costLabel` moves
  to `./counters.ts`. The transport panel's cost row uses it, so it reads as the strip.
