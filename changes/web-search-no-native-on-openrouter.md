---
packages: @parcha/agentrun-serve
kind: fix
---
On OpenRouter (OPENROUTER_API_KEY alone, or a model named `openrouter/<vendor>/...`), `web_search` on `auto` no longer picks Codex's own search, which OpenRouter does not run: a codex agent searches through Parallel on the server's key, else keyless Exa, and every model request is priced. A pick of `native` there resolves `unavailable: no native search for codex on OpenRouter` (likewise for claude-agent), saying why.
