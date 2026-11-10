---
type: llm
---
Pass only if a finding at `src/api/orders.ts` line 10 (the `placed_at: order.placedAt.toLocaleString(),` line) has
severity `important` and says the handler returns the order's time in the server's local zone and format instead of
through `formatUtc`, so customers in other time zones see a wrong or ambiguous time. Other findings do not change the
verdict.
