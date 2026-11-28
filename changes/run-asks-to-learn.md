---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
A run can ask to learn at its start: `POST /v2/agents/{id}/runs` takes `learning: {"settings": {...}}`, and the run learns for its agent with those loop numbers (`compile_after`, `agree_min`, `audit_every` and the rest a definition's `learning` object takes), whatever its revision's `learning` says. It must bring its own `model_key` and `max_cost_usd`; without both it is `400 learning_needs_cap` and nothing starts. All of its learning work spends that key inside that cap: its compile turn, its check's replay runs on their share of what the cap leaves, and its audit's shadow on what is left after. A replay or shadow that does not fit is dropped before it starts, with nothing spent, and the run says why in words in `learning_work.dropped` and in a `learning` row of its timeline. `capabilities.features.run_learning` says a server takes it. An inline run (`POST /v2/runs`) still takes `"use"` alone.
