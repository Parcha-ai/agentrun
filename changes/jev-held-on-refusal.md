---
packages: @parcha/agentrun-dsl, @parcha/agentrun-jev, @parcha/agentrun-decisions, @parcha/agentrun-web, @parcha/agentrun-serve
kind: fix
---
A Jev that answers 402 (out of credit) is now `payment_required`, a new `DecisionProviderErrorCode`, booked at $0 with a $0 line. It was `http`, booked at the hold on every request. A workflow's decision node books it at $0 too.
- web: once a Web's decider refuses its key (`auth`) or its account (`payment_required`), it is held for the rest of that Web: later searches and fetches send it nothing. A search's `sift` reads "not run (held); these results are unsifted", and a fetch's reads "objective not applied (held); this part is in page order". serve makes one Web per run, so Jev is held for the rest of the run. An outage (5xx or a timeout) is unchanged: booked at the hold, and asked again on the next search.
- dsl: in a map with `onItemFailure: "collect"`, a decision that answers `payment_required` now fails the run, as `auth` does, since every item would get the same 402. Before, a 402 was `http`, so each item failed on its own, booked at its hold, and the map went on.
- decisions: OpenRouter, Anthropic and Parallel now map a 402 to `payment_required`, as Jev does, so a workflow decision on an out-of-credit account is booked at $0. It was `http`, booked at the hold.
