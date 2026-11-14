---
packages: @parcha/agentrun-serve
kind: breaking
---
monid is granted per endpoint: `monid:<provider>/<endpoint>` (one endpoint, such as `monid:apollo/people/match`) or `monid:<provider>/*` (every endpoint monid lists for that provider, at most 50). The tools `monid.discover`, `monid.inspect` and `monid.run` are gone: an agent that grants one is refused at its save (422 `not_an_option`), and its owner grants the endpoints it calls instead.
- Each grant is read against monid's listing when the agent is saved, and pinned on that revision with the endpoint's description, its input schema and its price. A provider or endpoint monid does not list is refused at the save in words, and so is any monid grant saved with no monid key (Settings → Tool keys). An endpoint whose input schema the agent's harness would drop or retype (Codex's `patternProperties` or `not`, for example) is refused at the save as an MCP tool's is, naming the endpoint and the schema's path.
- Each pinned endpoint is one tool of its own on every harness, under its wire name (`monid:apollo/people/match` is `monid__apollo__people__match`). Its input is `{body, queryParams, pathParams}`, as monid's endpoint takes it.
- The gate and tool settings key a call by its endpoint (`monid:apollo/people/match`), or by the provider's wildcard (`monid:apollo/*`). A monid endpoint asks by default.
- A call is held on the run's ledger at the endpoint's pinned price: a per-call price, the dearest variant of a matrix, or a tiered price's default plus every tier. It is sent with that hold as monid's `maxCost`, so an endpoint monid has re-priced above its pin is refused unrun. The approval card shows that hold, and the charge row names the endpoint: "Tool cost: monid charged $0.0260 for monid:apollo/people/match".
- An endpoint monid prices by usage (per result, per unit, metered) cannot be granted: monid bounds no such call's charge, so no hold could keep a run's cap. A named grant of one is refused at the save, naming the endpoint and why; a provider's wildcard leaves it out and names it in the save's `warnings`.
- A workflow's nodes do not bind monid endpoints yet: a workflow granting one is refused at its save.
- Template packages may grant monid endpoints in `tools`, pinned at the apply's save.
