---
packages: @parcha/agentrun-serve
kind: breaking
---
monid is granted per endpoint: `monid:<provider>/<endpoint>` (one endpoint, such as `monid:apollo/people/match`) or `monid:<provider>/*` (every endpoint monid lists for that provider, at most 50). The tools `monid.discover`, `monid.inspect` and `monid.run` are gone: an agent that grants one is refused at its save (422 `not_an_option`), and its owner grants the endpoints it calls instead.
- Each grant is read against monid's listing when the agent is saved, and pinned on that revision with the endpoint's description, its input schema and its price. A provider or endpoint monid does not list is refused at the save in words, and so is any monid grant saved with no monid key (Settings → Keys).
- Each pinned endpoint is one tool of its own on every harness, under its wire name (`monid:apollo/people/match` is `monid__apollo__people__match`). Its input is `{body, queryParams, pathParams}`, as monid's endpoint takes it.
- The gate and tool settings key a call by its endpoint (`monid:apollo/people/match`), or by the provider's wildcard (`monid:apollo/*`). A monid endpoint asks by default.
- A call is held on the run's ledger at the endpoint's pinned price: a per-call price, the dearest variant of a matrix, or a tiered price's default plus every tier. An endpoint monid prices by usage is held at $1 until monid says what it charged. The approval card shows that hold, and the charge row names the endpoint: "Tool cost: monid charged $0.0260 for monid:apollo/people/match".
- A workflow's nodes do not bind monid endpoints yet: a workflow granting one is refused at its save.
- Template packages may grant monid endpoints in `tools`, pinned at the apply's save.
