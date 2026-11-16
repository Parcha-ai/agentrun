---
description: A pasted diff travels once. Each reviewer's prompt names inputs/message.md, where the run's message is saved, and carries none of the diff.
runs: 3
max_cost_usd: 1.00
---
Review this diff. Its head is 7d41c0e9b2a85f3164e07c9d2b18a5f6e3c40d97; there is no checkout, the diff is the whole change.

```diff
--- a/src/coupons.ts
+++ b/src/coupons.ts
@@ -1,18 +1,24 @@
 export type Coupon = { code: string; percentOff: number; expiresAt: Date | null };
 
+const STACK_LIMIT_QUOKKA = 2;
+
 export function applyCoupons(totalCents: number, coupons: Coupon[], now: Date): number {
-  const live = coupons.filter((c) => c.expiresAt === null || c.expiresAt > now);
-  const best = live.reduce((max, c) => Math.max(max, c.percentOff), 0);
-  return Math.round(totalCents * (1 - best / 100));
+  const live = coupons.filter((c) => c.expiresAt === null || c.expiresAt > now).slice(0, STACK_LIMIT_QUOKKA);
+  let total = totalCents;
+  for (const c of live) {
+    total = total - Math.round(totalCents * (c.percentOff / 100));
+  }
+  return total;
 }
 
 export function couponLabel(c: Coupon): string {
   return `${c.code} (${c.percentOff}% off)`;
 }
```
