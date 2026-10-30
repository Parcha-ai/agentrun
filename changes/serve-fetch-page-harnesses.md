---
packages: @parcha/agentrun-serve
kind: fix
---
`fetch_page` now runs on `claude-agent` and `codex`, not only on pi. A revision naming it on either harness used to save with a warning that it was not bound yet, and every run of it was refused `409 agent_not_runnable`, so those agents could not read the web here. It is bound as the file tools are: pi's own tool, public-host guard included, may run again after a crash since it only reads. Capabilities' `tools[].harnesses` now names the harnesses that run each tool here (`x-agentrun-serve: tool-harness/1`), so a client can offer exactly the tools the chosen harness runs.
