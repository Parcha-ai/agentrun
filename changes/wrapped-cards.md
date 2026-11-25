---
packages: @parcha/agentrun-serve
kind: feature
---
The console's Wrapped page draws its share cards, as 1200 by 675 images under the year's sections. Each card's words are its image's alt text. Four cards are drawn: "Your year in agents" (tokens, sessions, prompts, model requests, days at work and list price), "Where your tokens went" (each harness's and model's share of the tokens), "When your agents work" (the busiest hour and weekday, time at work, and requests by hour and by weekday) and a one-card summary. A card's numbers all come from `GET /v2/wrapped`.
- A list price stays "Unknown" when no request had a known price, never $0. Requests with no known price are counted on the card beside the price.
- A harness or model list longer than its card has room for shows the largest that fit, and the rest are added up in one "other" bar.
- When session files could not be read, each card says its numbers may be incomplete.
- A year with no sessions draws no cards.
- The cache grade, laptop, leak receipt, agent type and launch cards are not drawn yet. They each wait on something the year's answer does not have yet: the cache analyzer, the leak scan's counts-only mode, the launch benchmark, or rules that need subagent shares, parallelism, a month's cost and an electricity estimate.
