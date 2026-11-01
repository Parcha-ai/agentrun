---
packages: @parcha/agentrun-serve
kind: feature
---
`agentrun-serve import` keeps what each session used. Every imported run gets the store's metrics: its tokens, model requests, models, tool calls with their errors, the effort or thinking level it ran at, and its time at work (the gaps between the session's records, each capped at 15 minutes). The run's transcript carries each request's own tokens and model, so its timeline and its metrics agree. Claude Code's usage is read once per message, though the CLI repeats it on every record of a message. Codex's comes from its `token_usage_record`s, or from its `token_count` events in a rollout without them, with OpenAI's cached tokens taken out of the input. A Codex call fails when its output or its completed item says so. pi's usage is read as pi wrote it. A request whose source gave no counts stays unmetered, never 0 tokens. Runs imported before this change keep no metrics.
