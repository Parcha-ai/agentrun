---
packages: @parcha/agentrun-serve
kind: docs
---
The serve README and the setup skill say how to run claude-agent through an Anthropic-compatible gateway, such as LiteLLM's `/v1/messages`, with no Anthropic key: set `ANTHROPIC_BASE_URL` to the gateway and `ANTHROPIC_API_KEY` to its key, or any placeholder when the gateway adds its own. The README lists what the gateway must accept (`x-api-key`, Anthropic's own model ids, the CLI's `anthropic-beta` headers) and notes that a run's spend cap holds each request at a size bound there, since Anthropic's token count is asked only on `api.anthropic.com`.
