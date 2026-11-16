---
packages: @parcha/agentrun-serve
kind: fix
---
A pi run's effort now applies on an OpenRouter model that speaks Chat Completions, `openrouter/openai/gpt-6.1-sol` (pi's default on an OpenRouter key) included. Until now the route's translation sent the model no thinking level, so an effort set on such a run did nothing, and on a model that can stop reasoning (Ling 3.2 Flash) any effort was sent as reasoning off. Now the run's level reaches OpenRouter as `reasoning: { effort }`, mapped and clamped by the model's catalog entry. A run that sets an effort may cost more and take longer than it did; a run with no effort set sends what it sent before.
