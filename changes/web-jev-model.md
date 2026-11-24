---
packages: @parcha/agentrun-web
kind: fix
---
A Jev decider on TypeSafe's route (`jevProvider` reading `TYPESAFE_API_KEY`) sends `JEV_MODEL` (`jev-1.14.0`, the version `THRESHOLD`, `LOW_RELEVANCE` and the page guard's thresholds were read on) with every request unless `model` names another, never the moving `jev-latest` alias. On OpenRouter's route, and for any other provider, no model is sent and the provider's own default holds, as before.
- `DecisionAsker` gains an optional `needs`, the keys a provider reads, as the DSL's `DecisionProvider` has it.
