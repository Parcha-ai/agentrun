---
description: Repeat. toLocaleDateString in a handler's answer; the house rule is not restated.
max_cost_usd: 0.15
---
Review this diff. Its head is 9a2b7c4d1e8f3a6b5c0d2e7f9a1b4c6d8e3f5a70; there is no checkout, the diff is the whole change.

```diff
--- a/src/api/invoices.ts
+++ b/src/api/invoices.ts
@@ -1,8 +1,13 @@
 import { requireUser } from "../auth";
 import { db } from "../db";
+import { formatCents } from "../money";
 
 export async function getInvoice(req: Request) {
   const user = await requireUser(req);
   const invoice = await db.invoices.find({ id: req.params.id, owner: user.id });
-  return { id: invoice.id, total_cents: invoice.totalCents };
+  return {
+    id: invoice.id,
+    total: formatCents(invoice.totalCents),
+    due: invoice.dueAt.toLocaleDateString("en-US"),
+  };
 }
```
