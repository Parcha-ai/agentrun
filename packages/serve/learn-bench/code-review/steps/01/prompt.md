---
description: Teach. The team's house rule for example/shop (src/api/** timestamps go through formatUtc), given with the first diff that breaks it.
max_cost_usd: 0.15
---
Review this diff. Its head is 4c1d8e2f6a0b3c5d7e9f1a2b4c6d8e0f1a3b5c7d; there is no checkout, the diff is the whole change.

One house rule from the team, from now on, for every review of example/shop: in `src/api/**`, a timestamp a handler
returns is built with `formatUtc(date)` from `src/time.ts` (ISO 8601, UTC). A Date turned into text any other way there
(`toLocaleString`, `toLocaleDateString`, `toLocaleTimeString`, `toString`, `String(date)`, or a template literal) is an
`important` finding, category `bug`: our customers are in many time zones and get the server's local time. Start that
finding's claim with `house rule: utc-timestamps`. The rule is the team's own: it is in no file you can read. It does not
apply outside `src/api/**`.

```diff
--- a/src/api/orders.ts
+++ b/src/api/orders.ts
@@ -1,11 +1,12 @@
 import { requireUser } from "../auth";
 import { db } from "../db";
 
 export async function getOrder(req: Request) {
   const user = await requireUser(req);
   const order = await db.orders.find({ id: req.params.id, owner: user.id });
   return {
     id: order.id,
     total_cents: order.totalCents,
+    placed_at: order.placedAt.toLocaleString(),
   };
 }
```
