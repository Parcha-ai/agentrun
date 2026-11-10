---
packages: @parcha/agentrun-serve
kind: feature
---
`AGENTRUN_API_ONLY=1` makes the server serve the run routes alone, for a server behind its caller's backend: a run's launch, read, lists, timeline, messages, stop, cancel, kill and cap raise, its files and uploads, capabilities, health and usage. Every other address (the console at `/`, the store page's `/api/*`, sign-in, setup, settings, `/mcp`, triggers and their webhook hooks, agents, templates, the live views) is `404`, answered before the request is read further, and the server has no accounts. Off by default; a value other than `1`/`true` or `0`/`false` stops the start in words.
