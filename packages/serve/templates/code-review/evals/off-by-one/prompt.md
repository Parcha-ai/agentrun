---
description: A loop bound changes from < to <= over an array; the review finds the read past the end, with the failing input.
runs: 3
max_cost_usd: 0.10
---
Review this diff. Its head is 2a7b9c1d3e5f7081928374655647382910abcdef; there is no checkout, the diff is the whole change.

```diff
--- a/src/totals.ts
+++ b/src/totals.ts
@@ -1,7 +1,7 @@
 export function sumPrices(items: { price: number }[]): number {
   let total = 0;
-  for (let i = 0; i < items.length; i++) {
+  for (let i = 0; i <= items.length; i++) {
     total += items[i].price;
   }
   return total;
 }
```
