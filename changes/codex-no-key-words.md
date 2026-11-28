---
packages: @parcha/agentrun-serve
kind: fix
---
A codex (or other Responses-wire) agent on a server without the key it needs is refused in the harness's own words alone: "codex needs OPENAI_API_KEY, OPENROUTER_API_KEY …". The run's 409 and the save's warning no longer add the generic "No model yet" sentence, which told a person to set ANTHROPIC_API_KEY or PARTICLE_API_KEY, keys codex never runs on. A revision that names its own model still hears what that model needs.
