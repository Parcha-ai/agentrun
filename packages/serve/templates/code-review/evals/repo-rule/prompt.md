---
description: The repo's REVIEW.md says every handler checks the caller; a new handler doesn't, and the finding cites the rule's path:line.
runs: 3
max_cost_usd: 0.10
---
Review this diff. Its head is 5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081; there is no checkout. The repo's `REVIEW.md` at the base, with its line numbers:

```text
1  # Review rules
2
3  src/api/**: every handler checks the caller with requireUser(req) before it reads or writes data.
4  Money amounts are integers in cents.
```

```diff
--- a/src/api/invoices.ts
+++ b/src/api/invoices.ts
@@ -1,9 +1,15 @@
 import { requireUser } from "../auth";
 import { db } from "../db";
 
 export async function getInvoice(req: Request) {
   const user = await requireUser(req);
   return db.invoices.find({ id: req.params.id, owner: user.id });
 }
+
+export async function deleteInvoice(req: Request) {
+  await db.invoices.delete({ id: req.params.id });
+  return { ok: true };
+}
```
