---
packages: @parcha/agentrun-dsl
kind: feature
---
`DecisionProviderError` takes `unsent: true` from a provider that knows its request was never sent, for example a check before the request that a deadline or a cancel cut. Under a node's `timeoutMs`, `judgeFromProviders` turns a cut `aborted` or `timeout` into `outcome_unknown`, because the request may have been sent and billed, and the decision then goes to review. An `unsent` error keeps its own code instead, so the decision fails as `timeout` (or `aborted`) and asking it again costs nothing. `attempts` alone never says a request was unsent. An error without the field is handled as before.
