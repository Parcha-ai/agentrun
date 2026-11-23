---
packages: @parcha/agentrun-serve
kind: feature
---
The models of this machine's Ollama run on every harness on Anthropic's Messages, not just pi: claude-agent, Goose, and a harness module on that wire. They go through the same translation pi's requests take, so they get the same `/api/chat`, `num_ctx`, tools as text where a model needs it, $0, and no count toward `AGENTRUN_FREE_MODEL_REQUESTS`. They are listed in those harnesses' models and free models, and a run's page shows "<tag> · local (Ollama)". codex and opencode, on OpenAI's Responses, don't list them. The trust rules are unchanged: Ollama at the default address only on one owner's own server, and elsewhere only where `OLLAMA_HOST` names it.
- On upgrade: on a server with no model key and Ollama running, claude-agent and Goose now start the runs they refused before, on Ollama's first model that calls tools, as pi does. A saved agent on either harness that names no model follows that default. Name the model to pin it. Any key wins.
- With no model, their words name Ollama first, as pi's do: "No model yet for claude-agent: start Ollama and pull a model with tools, or add an OpenRouter or Anthropic key".
- A Messages client's token count (`POST /v1/messages/count_tokens`) is answered by the translation, without asking the model. A request that doesn't ask to stream gets its answer whole, or a 500 error with words when part of the stream doesn't read. Every model id the client sends, Claude Code's small model included, runs the one tag.
- On these models claude-agent turns off its own tool search and gets the server's `tools_search`, and it offers no provider web search.
- A harness module's launch (`ModuleLaunch`) gains `fetch`. When it is set, the module's model proxy forwards with it to the route's origin.
