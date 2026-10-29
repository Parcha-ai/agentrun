---
packages: @parcha/agentrun-jev, @parcha/agentrun-serve
kind: feature
---
**A decision Jev answers is booked at TypeSafe's published price, as an estimate**
- `jevProvider` prices the counted tokens of a TypeSafe call at `JEV_PUBLISHED_PRICING` ($0.042 per million input tokens, output tokens free) unless `pricing` says otherwise, and books it with `cost_basis: "estimate"`. A cost the response reports still wins, booked `reported`. With no token counts, on the OpenRouter route, or for a call that may have been billed, the cost stays `null`, never 0.
- agentrun-serve: a decision workflow run's `cost.usd` is its decisions' estimated sum, where it was `null` before.
