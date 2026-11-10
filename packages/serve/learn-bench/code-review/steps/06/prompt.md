---
description: Repeat. String(date) in a handler's answer.
max_cost_usd: 0.15
---
Review this diff. Its head is 8c1d4e7f0a3b6c9d2e5f8a1b4c7d0e3f6a9b2c5d; there is no checkout, the diff is the whole change.

```diff
--- a/src/api/sessions.ts
+++ b/src/api/sessions.ts
@@ -1,8 +1,8 @@
 import { requireUser } from "../auth";
 import { db } from "../db";
 
 export async function listSessions(req: Request) {
   const user = await requireUser(req);
   const sessions = await db.sessions.list({ owner: user.id });
-  return sessions.map((s) => ({ id: s.id, device: s.device }));
+  return sessions.map((s) => ({ id: s.id, device: s.device, last_seen: String(s.lastSeenAt) }));
 }
```
