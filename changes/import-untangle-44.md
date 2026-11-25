---
packages: @parcha/agentrun-import, @parcha/agentrun-serve
kind: fix
---
A Claude Code or pi request that failed, read with `turns: false`, keeps its error as `failed` (as OpenCode's does), never its text: the totals a home's import holds no longer carry a provider's error words. A source named twice in the CLI's `--sources` is read once, where it printed every session twice. Each reader has `idOf(locator)`, the id a read gives a session no record names, and serve's remote history probe takes its ids from it: a pi session whose `session` record names no id is exported under the id its read gives it, no longer skipped as changed. A pi-ai that fails to load now fails `builtinCatalog` and `priceRequests` with its reason, where it priced nothing and said nothing why.
