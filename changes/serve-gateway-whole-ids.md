---
packages: @parcha/agentrun-serve
kind: breaking
---
Through a gateway (`AGENT_MODEL_BASE_URL`), a revision that names its model as `provider/model-id` is now sent to the gateway whole (`openai/gpt-4o`), as a gateway like OpenRouter names its models `vendor/model`; it was sent as `model-id` alone. Who breaks: a gateway that expects the id without its provider. What to do: set `AGENT_MODEL_GATEWAY_IDS=bare` to keep the old behaviour. Unchanged: `AGENT_MODEL`, `AGENT_MODEL_FAST` and `AGENT_MODEL_STRONG` are sent as they are set, and the price is still the named provider's catalog entry for the model, else the highest.
