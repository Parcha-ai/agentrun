---
packages: @parcha/agentrun-serve
kind: fix
---
A model refused for a typo now names the model it likely means. When the name is one letter off a model a person may pick (a letter added, dropped or changed, or two swapped: `openai/gpt-6.1-sool`, `anthropic/claude-opsu-5-5`), the refusal ends "Did you mean openai/gpt-6.1-sol?", in the form the harness takes on this server (`openrouter/openai/gpt-6.1-sol` with only an OpenRouter key). It names one only when no other model is as near. Before, a typo got the form and an example but no likely id.
