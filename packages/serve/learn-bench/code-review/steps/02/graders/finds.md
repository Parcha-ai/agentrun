---
type: llm
---
Pass only if a finding at `src/api/invoices.ts` line 11 (the `due: invoice.dueAt.toLocaleDateString("en-US"),` line)
has severity `important` and says the due date is turned into text in the server's local zone instead of through
`formatUtc` (UTC, ISO 8601), so a customer in another time zone can see the wrong day. Other findings do not change the
verdict.
