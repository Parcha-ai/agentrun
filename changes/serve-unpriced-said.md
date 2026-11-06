---
packages: @parcha/agentrun-serve
kind: fix
---
A model serve has no price for (a gateway id with no `AGENT_MODEL_PRICE` that pi-ai's catalog does not list in any form)
is said so everywhere. A run on it on codex or opencode books each request at an unknown cost, never a known $0, so its
`cost.usd` is `null` and `/usage` counts it in `unpriced_runs` (before, their proxy priced it at the placeholder zeros).
Capabilities say it: `models.priced` (new) is false for such a default. And a run with `max_cost_usd` on it is refused
before it starts, 409 on `definition.model` in the cap's words, instead of being refused at its first request; an agent
saved with a default cap on one gets that as a warning.
