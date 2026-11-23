---
packages: @parcha/agentrun-serve
kind: feature
---
The models of this machine's Ollama run on codex and opencode too, and on a harness module on OpenAI's Responses. A Responses request goes through the same translation as pi's and the Messages harnesses' (`/api/chat`, `num_ctx`, tools as text where a model needs it), at $0, never counted toward `AGENTRUN_FREE_MODEL_REQUESTS`. They are listed in those harnesses' models and free models. The trust rules are unchanged: Ollama at the default address only on one owner's own server, and elsewhere only where `OLLAMA_HOST` names it.
- On upgrade: on a server with no model key and Ollama running, codex and opencode now start the runs they refused before, on Ollama's first model that calls tools. A saved agent on either harness that names no model follows that default. Name the model to pin it. Any key wins.
- Each request is the whole conversation. `store: true` and `previous_response_id` are refused with a 400 that says so. Replayed reasoning, OpenAI's encrypted reasoning included, is dropped.
- Function tools only. A custom (freeform) tool, `local_shell` and `web_search` are refused with a 400 naming the tool, never dropped. codex offers no live web search on these models.
- An answer cut at its output limit ends `response.incomplete` (`max_output_tokens`) with its usage: it is booked, and codex ends the turn instead of asking again.
- Every model id a client sends (codex's title and compaction requests, opencode's small model) runs the one tag.
