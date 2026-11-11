---
description: Repeat. A handler moves one field to formatUtc and adds another with toLocaleTimeString; only the new one is a finding.
max_cost_usd: 0.15
---
Review this diff. Its head is 0a3b6c9d2e5f8a1b4c7d0e3f6a9b2c5d8e1f4a7b; there is no checkout, the diff is the whole change.

```diff
--- a/src/api/reports.ts
+++ b/src/api/reports.ts
@@ -1,11 +1,13 @@
 import { requireUser } from "../auth";
 import { db } from "../db";
+import { formatUtc } from "../time";
 
 export async function getReport(req: Request) {
   const user = await requireUser(req);
   const report = await db.reports.find({ id: req.params.id, owner: user.id });
   return {
     id: report.id,
-    generated_at: report.generatedAt.toISOString(),
+    generated_at: formatUtc(report.generatedAt),
+    window: `${report.from.toLocaleTimeString()} to ${report.to.toLocaleTimeString()}`,
   };
 }
```
