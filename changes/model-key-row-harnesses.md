---
packages: @parcha/agentrun-serve
kind: fix
---
`GET /v2/settings/tool-keys` names, for a model key, every harness its key runs that this server could run, before the key is saved: OpenRouter's row lists pi, claude-agent and codex, Anthropic's pi and claude-agent, OpenAI's pi and codex. Before, a harness waiting on a model key dropped out, so with none saved OpenRouter's row read pi alone. A harness left out is one this server cannot run for another reason: not installed, not the pinned build, or more than this host's memory. Where the host names claude-agent's endpoint (`ANTHROPIC_BASE_URL`), OpenRouter's row leaves claude-agent out, since that endpoint takes Anthropic's key alone. An `ANTHROPIC_BASE_URL` claude-agent refuses is now its reason before a missing key, and no key row lists claude-agent behind it. Capabilities' `harnesses` are unchanged.
