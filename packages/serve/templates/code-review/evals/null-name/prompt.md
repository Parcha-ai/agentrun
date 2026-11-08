---
description: A one-line change drops a null guard; the review finds it and answers in the findings shape.
runs: 3
max_cost_usd: 0.10
---
Review this diff. Its head is 1f0c6a3d2b9e8f7a6c5d4e3b2a1908f7e6d5c4b3; there is no checkout, the diff is the whole change.

```diff
--- a/src/users.js
+++ b/src/users.js
@@ -1,4 +1,4 @@
 export function displayName(users, id) {
   const user = users.find((u) => u.id === id);
-  return user ? user.name : "unknown";
+  return user.name.trim();
 }
```
