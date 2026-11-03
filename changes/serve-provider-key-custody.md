---
packages: @parcha/agentrun-serve
kind: fix
---
A model key set for one of pi-ai's other providers (`GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY`, Bedrock's `AWS_*` keys, about forty in all) is now held like `OPENAI_API_KEY`: the launcher takes it out of the server's environment, and a run's process gets it over its pipe only when its model is that provider's. Before, the launcher named four providers' keys, and every other one stayed in the server's environment and in every run's, where Codex's process, a program a run started or any process of the same user could read it. Operators set the same variables.

- No run's environment, nor docker's probe's, holds a variable named like a key (`*_API_KEY`, `*_TOKEN`, any with `SECRET` or `PASSWORD`), on the launcher's list or not. Only the run's pipe descriptor and length pass by name. The import's cut takes the same rule.
- A run on Bedrock passes the AWS keys its process holds to each request, as pi-ai's Bedrock request reads them, instead of from an environment.
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` and `AGENT_MODEL_API_KEY` still reach every run, as codex, claude-agent, the gateway and Jev's judges take them.
- Not covered: a key-shaped variable the launcher's list does not name stays in the server's own environment; Bedrock credentials by container full URI with `AWS_CONTAINER_AUTHORIZATION_TOKEN` are not supported for runs; a pi run on a `typesafe/` model does not get `TYPESAFE_API_KEY`, a decision key.
