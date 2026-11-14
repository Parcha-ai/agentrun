---
packages: @parcha/agentrun-serve
kind: fix
---
Behind serve's gateway (`AGENT_MODEL_BASE_URL`), pi sends a Claude model on Anthropic's Messages API (`<base>/v1/messages`) instead of OpenAI's Responses API, so its prompt cache works: the second turn of a run reads the prompt from cache, where every turn used to pay full input. Every other model stays on the Responses API.
- A model is Claude's when its id names Anthropic as its vendor (`anthropic/claude-sonnet-5.5`, or a revision's `anthropic/...` with bare gateway ids), or names no vendor and pi-ai's catalog lists it under Anthropic (`claude-opus-5-5`). The gateway must serve `/v1/messages` beside `/v1/responses`, as LiteLLM's proxy and OpenRouter do; its key goes as a bearer token, as on Responses.
- Cache reads and writes are booked at the model's own rates (the catalog's, or the 3rd and 4th numbers of `AGENT_MODEL_PRICE`), so the run's cost is the sum of its turns. With `AGENT_MODEL_PRICE` set for a Claude model, give its cache write price (Anthropic's is 1.25 times input): left out, a write is booked at the input price.
- The same route serves a learned workflow's model nodes and the learning grader on a Claude gateway model. Claude Code, Codex and opencode send as before.
