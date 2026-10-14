---
packages: repo
kind: breaking
---
`@parcha/agentrun-pi` targets Pi 1.1.0. Breaking for standalone use: `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` and `typebox` move from exact dependencies to optional peer dependencies at `*`, which is Pi's own packaging rule (a second physical copy can shadow the host's). `pi install` needs nothing more; an application or the `agentrun-pi` CLI installs the peers itself. A host tool called from a workflow now receives Pi 1.1's tool context (`tools`, and an `executeTool` that answers with an error outcome, since a workflow node has no sibling tools). `PiRunError` moves to its own module so the workflow service loads without a Pi package installed. `/agentrun status` reports Pi 1.1.0 as the tested host.
