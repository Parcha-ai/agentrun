---
type: llm
---
Pass only if BOTH of these findings are present:
1. At `src/api/credit-notes.ts`, on the `deleteCreditNote` lines (9-12): the handler deletes without `requireUser`, so
   any caller can delete any credit note by id, and it cites the rule as `REVIEW.md:3`.
2. At `src/api/credit-notes.ts` line 11, severity `important`: `deleted_at` is `new Date().toLocaleString()`, the
   server's local-time text, not `formatUtc`.
One finding that states both, at line 11, also passes. Other findings do not change the verdict.
