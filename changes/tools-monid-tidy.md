---
packages: @parcha/agentrun-kernel, @parcha/agentrun-serve
kind: breaking
---
The kernel's `isCatalogName` is now `isCatalogWire`, and it matches a monid endpoint's wire name by `monid__` (the name every harness calls it by), no longer by the old single `monid_`. A host that imported `isCatalogName` from `@parcha/agentrun-kernel` imports `isCatalogWire` instead.
- An agent's monid pin is kept on its revision beside its MCP pin (`revisions.monid_pin`; Postgres migration `0012_revision_monid_pin.sql`, and a server open adds the column to a SQLite store), no longer inside the revision's body. An edit that leaves an agent's monid grants as they were reads nothing of monid's listing and keeps the pin; a grant it adds is read alone. A revision saved before this keeps its endpoints only once it is saved again.
- One check holds MCP and monid grants at the save and before each run. Its words for a tool the harness would drop or retype are "The tool <catalog name> cannot be offered on <harness>: <why>." for both sources. A workflow's monid grant is refused in the MCP grant's words: "<grant>: a workflow's nodes don't bind monid endpoints here yet; grant it to an agentic agent."
- A name that is no tool here is refused as "<name> is not a tool here: grant one of <the server's tools>, an MCP server's tool as mcp:<server>/<tool>, or a monid endpoint as monid:<provider>/<endpoint>."
- The monid key check reads `GET /v1/endpoints?limit=1`, the listing a save pins from, which monid does not charge for.
- A subagent given a grant gets each of the run's catalog tools that grant gives by the gate's keys, for MCP and monid alike.
