---
packages: @parcha/agentrun-serve
kind: fix
---
A tool this server does not register defaults to ask, not allow; the tool list is one table.
- Before, a name that was neither a table tool nor a catalog tool (`monid.<tool>`, `mcp:<server>/<tool>`) defaulted to allow in `defaultPermission`. Now only a built-in (a row of the tool list, `learned_workflow`, a computer kind's key, a decision provider's) allows by default and anything else asks. No tool of today's table changes: the capabilities and agent-tools views are the same.
- `replay`, `blurb`, `host`, `askable` and `table` are fields of each tool's row in `tool-list.ts`; `TABLE_TOOLS`, `ASKABLE`, `REPLAY`, `TOOL_BLURBS`, `webToolNames` and `tool-blurbs.ts` are gone.
