---
packages: @parcha/agentrun-kernel, @parcha/agentrun-harness-claude, @parcha/agentrun-serve
kind: fix
---
A capped run straight to Anthropic is no longer paused by a cap it could work under. Before each answer request on a route to `https://api.anthropic.com` (pi and claude-agent), the model proxy asks Anthropic's free token count (`POST /v1/messages/count_tokens`). It sends only the credential and version headers, and never goes through a gateway or any other base. The request's input bound is then that count plus the tool-use prompt, where before it was the body's bytes (about two to three times the tokens billed). A count that fails, says nothing or takes over 3 seconds leaves the byte bound, and the request goes on. Through OpenRouter or any other gateway the bound stays the bytes, so the cap still never passes.

The serve README's spend-cap section now states the smallest cap that works, measured on a pi desktop run on Sonnet: $0.05 for the first request and $0.11 for a five-step run through a gateway; $0.03 and $0.09 straight to Anthropic. The console's cap fields say it in a line, with a link. A cap below these still pauses with `Not sent: ... the next step needs at least $X`. A policy may count a request through `ProviderPolicy.countInput` (`InputCounter`, `countedInputOf` in the kernel host).
