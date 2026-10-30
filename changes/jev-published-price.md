---
packages: @parcha/agentrun-jev
kind: feature
---
**A decision Jev answers is booked at TypeSafe's published price, as an estimate**
- `jevProvider` prices the counted tokens of a TypeSafe call at the new export `JEV_PUBLISHED_PRICING` ($0.042 per million input tokens, output tokens free, from TypeSafe's models page) unless `pricing` says otherwise, and books it with `cost_basis: "estimate"`. With no token counts, on the OpenRouter route, or for a call that failed or may have been billed, the cost stays `null`, never 0.
- A cost the response reports still wins, and is now booked `reported` even when a price is set; before, it read `estimate` whenever `pricing` was given.
