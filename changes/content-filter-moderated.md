---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel, @parcha/agentrun-harness-claude, @parcha/agentrun-harness-codex
kind: fix
---
A run whose model provider stops the answer on its content filter now ends `failed` with `error.code` `moderated` and
says so in plain words: "The model provider stopped this answer (its content filter). Rephrase the request, or try
another model." Before, it ended `run_failed` with the provider's jargon ("Response incomplete: content_filter"). The
provider's own words stay on the Timeline's error row. On pi the run reads pi-ai's words for the stop on each API. On
claude-agent and codex the session's model proxy reads the provider's stop (Anthropic's `refusal`, an OpenAI answer
`incomplete` for `content_filter`) and the harness ends the turn at once: the CLI no longer asks for the refused answer
again, turn after turn. Only the turn's own answer request ends it: a side call the CLI makes beside the turn (one
without the session's tools) that the provider stops is logged and left to the CLI. The refused request is booked at
the usage its end reports. The kernel exports `CONTENT_FILTERED`, the text such a turn ends with; a provider policy may
say a stop through `filtered` and a side call through `answers`, and the model proxy tells its machine through
`onFiltered`.
