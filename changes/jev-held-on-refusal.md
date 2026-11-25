---
packages: @parcha/agentrun-dsl, @parcha/agentrun-jev, @parcha/agentrun-web, @parcha/agentrun-serve
kind: fix
---
A Jev that answers 402 (out of credit) is now `payment_required`, a new `DecisionProviderErrorCode`, booked at $0 with a $0 line. It was `http`, booked at the hold on every request. A workflow's decision node books it at $0 too.
- web: once a Web's decider refuses its key (`auth`) or its account (`payment_required`), it is held for the rest of that Web: later searches and fetches send it nothing. A search's `sift` reads "not run (held); these results are unsifted", and a fetch's reads "objective not applied (held); this part is in page order". serve makes one Web per run, so Jev is held for the rest of the run. An outage (5xx or a timeout) is unchanged: booked at the hold, and asked again on the next search.
