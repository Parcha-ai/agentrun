---
type: llm
---
Pass only if a finding at `src/api/invoices.ts` on the `deleteInvoice` lines (9-12) says the handler deletes without `requireUser`, so any caller can delete any invoice by id, AND it cites the rule as `REVIEW.md:3`. Fail if the citation is missing or names another line, or if any other finding is reported.
