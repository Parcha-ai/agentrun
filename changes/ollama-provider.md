---
packages: @parcha/agentrun-serve, @parcha/agentrun, @parcha/agentrun-kernel
kind: feature
---
The server lists the models of this machine's Ollama itself, as `ollama/<tag>` on pi, with no key and no gateway. Start Ollama and its models are in capabilities, the Model picker and pi's free models within half a minute, with no restart. `OLLAMA_HOST` says where it listens, read as the ollama CLI reads it (unset: 127.0.0.1:11434; plain http to loopback alone). Requests go to Ollama's own `/api/chat` with `num_ctx` the model's trained context up to 65,536. A model without the `tools` capability takes its tools as text. They cost $0 and never count toward `AGENTRUN_FREE_MODEL_REQUESTS`, and the console shows no request limit for them. With no model key held, pi's default is the first Ollama model that calls tools; any key wins. A down or stuck Ollama lists nothing and stalls nothing.
- `agentrun service install --env OLLAMA_HOST=<host:port>` gives the service an Ollama off its default address. A service that reaches Ollama through `AGENT_MODEL_BASE_URL` keeps working as before; under a gateway, Ollama is never asked.
- A run's page names the model it ran on, a run on the host default included, read from its `tokens` usage line: "qwen3:8b · local (Ollama)" for an Ollama model.
- A model without the `thinking` capability whose answer opens with `<think>` has that part as thinking up to `</think>`, so the tags stay out of the answer.
- `CapModel.local` marks a model on the host's own machine: free, and never counted toward the server's free-model limit (`limitedFree`). An agent's own `max_requests` still counts its requests, beside the run's other free ones, so a run on Ollama stops there.
