---
packages: @parcha/agentrun-serve
kind: fix
---
A model its harness never runs is refused as that, in the words the harness gives once the key is set: a codex agent on `anthropic/claude-sonnet-5-5` reads "codex runs OpenAI models; the run's model is anthropic/claude-sonnet-5-5." on its save and its run, where a server without an Anthropic key used to ask for ANTHROPIC_API_KEY, which would not make codex run it. The same holds for claude-agent on an OpenAI model. A model the harness does run still says the key it lacks.
