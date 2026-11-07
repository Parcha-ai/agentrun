---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: breaking
---
**`fetch_page` is gone: grant `web_fetch` instead.** web_fetch's old name no longer saves, runs, maps to a permission or gets a Timeline label: a revision, a model node or a call node naming it is refused like any tool this server does not bind (`422 not_an_option` at its `tools[i]`), and the gate maps it to no settings key. `@parcha/pi-durable-agent` registers its fetch label and outcome for `web_fetch` alone.
