---
packages: repo
kind: feature
---
**`apps/viewer`: vision on the counters strip**
- Paid calls made counts vision's paid looks, per look key over ok looks that are not the lead's own: each filing that
  is not kept is a payment, and a key whose first ok filing is kept (the eyes answered in a process that died before
  filing it) is one, priced from that filing; a kept filing after a payment adds nothing.
- Repeated and asked twice count each extra payment of a key once, by generation. Cost adds each payment's
  `facts.cost_usd` and each failed look's (a failed look is no payment); a native look charges nothing and never makes
  cost unknown. The latest revision of a filing says what it cost.
- The reference example's manifest cost (`examples/reference/fold.ts`, which stands alone) prices looks by the same
  rule, and a test holds it equal to the viewer's on each rule. A look record with no `facts.key` is not a look and
  prices nothing; before, every record's `cost_usd` counted.
- A look live lines show started in a process that neither filed it nor had it read back as kept later is a possible
  payment no durable line shows: the strip says so, and the cost reads "at least".
