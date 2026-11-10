---
description: Repeat. The repo's REVIEW.md requireUser rule (as in evals/repo-rule) and the house rule are both broken by one new handler.
max_cost_usd: 0.15
---
Review this diff. Its head is 5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081; there is no checkout. The repo's `REVIEW.md` at the base, with its line numbers:

```text
1  # Review rules
2
3  src/api/**: every handler checks the caller with requireUser(req) before it reads or writes data.
4  Money amounts are integers in cents.
```

```diff
--- a/src/api/credit-notes.ts
+++ b/src/api/credit-notes.ts
@@ -1,7 +1,12 @@
 import { requireUser } from "../auth";
 import { db } from "../db";
 
 export async function getCreditNote(req: Request) {
   const user = await requireUser(req);
   return db.creditNotes.find({ id: req.params.id, owner: user.id });
 }
+
+export async function deleteCreditNote(req: Request) {
+  await db.creditNotes.delete({ id: req.params.id });
+  return { ok: true, deleted_at: new Date().toLocaleString() };
+}
```
