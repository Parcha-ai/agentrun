---
description: Two files, one defect each, the second quieter than the first; the sweep keeps going after the first finding and covers both files.
runs: 3
max_cost_usd: 0.10
---
Review this diff. Its head is 8b9c0d1e2f30415263748596a7b8c9d0e1f20314; there is no checkout, the diff is the whole change.

```diff
--- a/src/cart.ts
+++ b/src/cart.ts
@@ -1,3 +1,3 @@
 export function lastItem(items: string[]): string | undefined {
-  return items[items.length - 1];
+  return items[items.length];
 }
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,6 +1,5 @@
 /** The request timeout: TIMEOUT_MS, or 30 seconds when it is unset. */
 export function timeoutMs(env: Record<string, string | undefined>): number {
-  const raw = env.TIMEOUT_MS;
-  return raw ? Number(raw) : 30_000;
+  return Number(env.TIMEOUT_MS);
 }
```
