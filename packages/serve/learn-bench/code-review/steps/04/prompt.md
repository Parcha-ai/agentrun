---
description: Repeat, negative. The handler uses formatUtc as the house rule asks; no rule finding may be reported.
max_cost_usd: 0.15
---
Review this diff. Its head is 7b0c3d6e9f2a5b8c1d4e7f0a3b6c9d2e5f8a1b4c; there is no checkout, the diff is the whole change.

```diff
--- a/src/api/payouts.ts
+++ b/src/api/payouts.ts
@@ -1,8 +1,9 @@
 import { requireUser } from "../auth";
 import { db } from "../db";
+import { formatUtc } from "../time";
 
 export async function getPayout(req: Request) {
   const user = await requireUser(req);
   const payout = await db.payouts.find({ id: req.params.id, owner: user.id });
-  return { id: payout.id, amount_cents: payout.amountCents };
+  return { id: payout.id, amount_cents: payout.amountCents, paid_at: formatUtc(payout.paidAt) };
 }
```
