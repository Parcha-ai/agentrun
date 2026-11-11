---
type: llm
---
Pass only if BOTH of these findings are present:
1. At `src/api/refunds.ts` line 7 or 8: pages start at 1 (the default), but the slice starts at `page * 20`, so page 1
   returns rows 20-39 and the first 20 refunds can never be listed.
2. At `src/api/refunds.ts` line 12 (the `refunded_at: \`${r.refundedAt}\`,` line), severity `important`: the template
   literal turns the Date into the server's local-time text instead of going through `formatUtc`.
Other findings do not change the verdict.
