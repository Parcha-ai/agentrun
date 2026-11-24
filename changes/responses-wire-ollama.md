---
packages: @parcha/agentrun-serve
kind: feature
---
The models of this machine's Ollama run on codex and opencode too, and on a harness module on OpenAI's Responses. A Responses request goes through the same translation as pi's and the Messages harnesses' (`/api/chat`, `num_ctx`, tools as text where a model needs it), at $0, never counted toward `AGENTRUN_FREE_MODEL_REQUESTS`. They are listed in those harnesses' models and free models. The trust rules are unchanged: Ollama at the default address only on one owner's own server, and elsewhere only where `OLLAMA_HOST` names it.
- On upgrade: on a server with no model key and Ollama running, codex and opencode now start the runs they refused before, on Ollama's first model that calls tools. A saved agent on either harness that names no model follows that default. Name the model to pin it. Any key wins.
- Each request is the whole conversation. `store: true` and `previous_response_id` are refused with a 400 that says so. Replayed reasoning, OpenAI's encrypted reasoning included, is dropped.
- Function tools only. A custom (freeform) tool, `local_shell` and `web_search` are refused with a 400 naming the tool, never dropped. codex offers no live web search on these models.
- A `tool_choice` that forces a call (`"required"`, or one naming a function) is refused with a 400: Ollama can't be made to call a tool. `"auto"` and `"none"` are taken.
- `text.format` `json_schema` is Ollama's own `format`: the answer is held to the schema. `json_object` is held to any JSON object. Beside tools sent, a format is refused with a 400, since a model held to a format can't call a tool. A format of another type is refused too.
- `temperature` and `top_p` reach Ollama's options. On a thinking model, `reasoning.effort` turns Ollama's thinking on, and `"none"` turns it off. An effort the route doesn't know is refused.
- `parallel_tool_calls: false` (codex sends it for a model it doesn't know) gets an answer's first tool call alone: Ollama has no switch for one call per answer.
- A request streams only with `stream: true`. One that names no stream gets the whole response as one JSON body, as OpenAI's API answers it.
- On the Messages wire too, an Ollama model now takes a request's `temperature`, `top_p` and `output_config.format` (a JSON schema).
- codex and opencode are told the model's window as the route runs it (its `num_ctx`: the model's trained context, at most 64k, at most `OLLAMA_CONTEXT_LENGTH`), not their 272,000 default, so they compact before Ollama would cut the prompt.
- Their output ceiling is the route's too (half the window, at most 16,384), not their 32,000 default.
- An answer cut at its output limit ends `response.incomplete` (`max_output_tokens`) with its usage: it is booked, and codex ends the turn instead of asking again.
- Every model id a client sends (codex's title and compaction requests, opencode's small model) runs the one tag.
