---
description: A rename with no change in behaviour; the review reports nothing.
runs: 3
max_cost_usd: 0.10
---
Review this diff. Its head is 3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f; there is no checkout, the diff is the whole change.

```diff
--- a/src/format.ts
+++ b/src/format.ts
@@ -1,9 +1,9 @@
-export function fmt(amountCents: number, currency: string): string {
-  const units = amountCents / 100;
+export function formatMoney(amountCents: number, currency: string): string {
+  const amount = amountCents / 100;
   return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
-    units,
+    amount,
   );
 }
--- a/src/invoice.ts
+++ b/src/invoice.ts
@@ -1,5 +1,5 @@
-import { fmt } from "./format";
+import { formatMoney } from "./format";
 
 export function invoiceLine(name: string, cents: number): string {
-  return `${name}: ${fmt(cents, "USD")}`;
+  return `${name}: ${formatMoney(cents, "USD")}`;
 }
```
