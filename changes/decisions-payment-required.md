---
packages: @parcha/agentrun-dsl, @parcha/agentrun-decisions, @parcha/agentrun-serve
kind: fix
---
OpenRouter, Anthropic and Parallel now map a 402 (the account is out of credit) to `payment_required`, as Jev does. It was `http`. A workflow decision on an out-of-credit account is now booked at $0, and serve's run cost says $0, where it booked the hold.
- dsl: in a map with `onItemFailure: "collect"`, a decision that answers `payment_required` now fails the run, as `auth` does, since every item would get the same 402. Before, a 402 was `http`, so each item failed on its own, booked at its hold, and the map went on.
