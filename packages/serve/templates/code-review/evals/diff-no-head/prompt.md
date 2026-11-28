---
description: A pasted diff that names no head commit (its index line holds blob hashes); the review finds the read past the end and answers head_sha null, never a sha made from the index line.
runs: 3
max_cost_usd: 0.25
---
Review this change (a diff, no pull request).

```diff
diff --git a/src/total.js b/src/total.js
index 3b18e51..9c2d1aa 100644
--- a/src/total.js
+++ b/src/total.js
@@ -1,9 +1,9 @@
 // The cart's total in cents: each item's price times its quantity.
 export function total(items) {
   let sum = 0;
-  for (let i = 0; i < items.length; i++) {
+  for (let i = 0; i <= items.length; i++) {
     sum += items[i].price * items[i].quantity;
   }
   return sum;
 }
```
