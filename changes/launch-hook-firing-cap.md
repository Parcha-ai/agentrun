---
packages: @parcha/agentrun-serve
kind: feature
---
A launch hook firing now carries `max_cost_usd`, its trigger's cap (`null` when the target sets none and the agent's default bounds the run), so a host that pays for runs checks the payer's balance at the cap the run will hold.
- The firing keeps the cap it was handed with: a retried hand sends the same one, and the run the host starts for the firing runs under it (or under the host's own `max_cost_usd` when lower), even if the trigger's target was raised after the hand. A `null` means the agent's default when the host starts the run.
- The store keeps that cap with the firing (`trigger_firings.hooked`): Postgres migration 0035, additive, and on SQLite the server adds the column at its open.
