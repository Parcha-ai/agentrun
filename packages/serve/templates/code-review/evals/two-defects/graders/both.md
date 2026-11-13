---
type: llm
---
Pass only if the findings include both of these, and no other: (a) `src/cart.ts` line 2, `P0` or `P1`, saying `items[items.length]` is always undefined, so `lastItem` returns undefined for every non-empty list; (b) `src/config.ts` line 3, `P0` or `P1`, saying an unset `TIMEOUT_MS` now gives `Number(undefined)`, which is NaN, instead of the documented 30-second default. And `coverage` has an entry for each of `src/cart.ts` and `src/config.ts`, and `risk_score` is 4 or 5. Fail if either finding is missing, if a file has no coverage entry, or if any other finding is reported.
