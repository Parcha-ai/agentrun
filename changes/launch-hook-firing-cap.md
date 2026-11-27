---
packages: @parcha/agentrun-serve
kind: feature
---
A launch hook firing now carries `max_cost_usd`, its trigger's cap (`null` when the target sets none and the agent's default bounds the run), so a host that pays for runs checks the payer's balance at the cap the run will hold.
