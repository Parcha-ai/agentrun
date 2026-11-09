---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: breaking
---
**`fetch_page` is gone: grant `web_fetch` instead.** web_fetch's old name no longer saves, runs, maps to a permission or gets a Timeline label: a revision naming it is refused like any tool this server does not bind (`422 not_an_option` at its `tools[i]`), a workflow whose model or call node names it at `definition.workflow`, and the gate maps it to no settings key. Upgrading: an agent saved before this that still grants `fetch_page` is refused at its next run (`409 agent_not_runnable`, `details.unbound`) until it is saved again with `web_fetch`. `@parcha/pi-durable-agent` registers its fetch label and outcome for `web_fetch` alone.
