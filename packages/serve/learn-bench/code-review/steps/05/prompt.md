---
description: Repeat, scope. toLocaleString in a job's log line, outside src/api/**; the house rule does not apply there.
max_cost_usd: 0.15
---
Review this diff. Its head is 3f6a9b2c5d8e1f4a7b0c3d6e9f2a5b8c1d4e7f0a; there is no checkout, the diff is the whole change.

```diff
--- a/src/jobs/digest.ts
+++ b/src/jobs/digest.ts
@@ -1,7 +1,8 @@
 import { db } from "../db";
 import { log } from "../log";
 
 export async function runDigest(now: Date) {
   const due = await db.digests.due(now);
+  log.info(`digest run at ${now.toLocaleString()}: ${due.length} due`);
   for (const d of due) await d.send();
 }
```
