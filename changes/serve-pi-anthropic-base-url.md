---
packages: @parcha/agentrun-serve
kind: fix
---
pi honors `ANTHROPIC_BASE_URL` as claude-agent does: every request on an Anthropic model (a run's turns, compaction, a
hosted search, a learned node, a grade) goes to `<base>/v1/messages` with `ANTHROPIC_API_KEY` as `x-api-key` alone. Before,
pi sent to api.anthropic.com, and behind a gateway its run failed with 401 while capabilities said its default model was
ready. Capabilities now read pi's Anthropic default ready only where that route runs: with `ANTHROPIC_BASE_URL` set, it
needs `ANTHROPIC_API_KEY` (not `ANTHROPIC_AUTH_TOKEN`) and a base a key may go to. A base a key may not go to refuses
Anthropic's models alone: another provider's model is ready and runs.
