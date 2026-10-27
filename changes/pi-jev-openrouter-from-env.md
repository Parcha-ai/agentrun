---
packages: @parcha/agentrun-pi
kind: fix
---
The `/agentrun` extension takes Jev's provider from the environment, as the Jev adapter's `jevProviderFromEnv` does: with only `OPENROUTER_API_KEY` set, a workflow's Jev decisions (including `/agentrun demo live`) go to Jev through OpenRouter instead of being refused for a missing `TYPESAFE_API_KEY`. With both keys set, TypeSafe is used as before. The configuration refusal names both keys, and `/agentrun status` says whether Jev goes via TypeSafe or OpenRouter.
