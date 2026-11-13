---
description: The repo's CODEREVIEW.md names a P0 class and a class never to flag; the diff has one of each, and the review reports only the P0.
runs: 3
max_cost_usd: 0.10
---
Review this diff. Its head is 7a8b9c0d1e2f30415263748596a7b8c9d0e1f203; there is no checkout. The repo's `CODEREVIEW.md` at the base, with its line numbers:

```text
1  # CODEREVIEW.md
2
3  ## What counts as a bug here
4  - P0: spend booked as $0 when it is unknown, so a capped run spends past its cap.
5
6  ## Never flag
7  - Old rows, data or servers losing something on upgrade: no backwards compatibility before 1.0, no legacy readers.
```

```diff
--- a/src/usage.ts
+++ b/src/usage.ts
@@ -1,7 +1,6 @@
 export type Row = { runId: string; spentUsd: number | null; legacyCostCents?: number };
 
 /** Spend of one run: null when unknown. A capped run admits no more work while its spend is unknown. */
 export function spendOf(row: Row): number | null {
-  if (row.spentUsd === null && row.legacyCostCents !== undefined) return row.legacyCostCents / 100;
-  return row.spentUsd;
+  return row.spentUsd ?? 0;
 }
```
