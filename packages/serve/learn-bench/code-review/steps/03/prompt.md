---
description: Repeat. A new handler with a paging off-by-one and a Date in a template literal; both are findings.
max_cost_usd: 0.15
---
Review this diff. Its head is 2e5f8a1b4c7d0e3f6a9b2c5d8e1f4a7b0c3d6e9f; there is no checkout, the diff is the whole change.

```diff
--- /dev/null
+++ b/src/api/refunds.ts
@@ -0,0 +1,14 @@
+import { requireUser } from "../auth";
+import { db } from "../db";
+
+export async function listRefunds(req: Request) {
+  const user = await requireUser(req);
+  const refunds = await db.refunds.list({ owner: user.id });
+  const page = Number(req.query.page ?? 1);
+  const rows = refunds.slice(page * 20, page * 20 + 20);
+  return rows.map((r) => ({
+    id: r.id,
+    amount_cents: r.amountCents,
+    refunded_at: `${r.refundedAt}`,
+  }));
+}
```
