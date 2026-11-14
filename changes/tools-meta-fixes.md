---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel, @parcha/agentrun-harness-claude
kind: fix
---
Three follow-ups to the tools_search / tools_call / codemode rule, found in a live walk.
- Claude Code now follows the same switch as every other harness. With `tools_search` or `tools_call` set to deny, its own tool search is off and every tool is listed; before, it deferred a run's catalog tools behind its own ToolSearch whatever the setting said. The server makes the one decision (`SessionSpec.deferCatalog`) and Claude Code's adapter obeys it.
- Settings → Tools lists `tools_search`, `tools_call` and `codemode`, each allow or deny, allow by default. They are in `capabilities.tools` with `meta: true` (no grant: the agent editor does not offer them) and a one-line blurb.
- codemode's description names real functions of the run (`tools.<name>`, the first three) and says to leave off the prefix a harness shows in the model's own tool list (`hands_`, `mcp__hands__`). On OpenCode a script wrote `tools.hands_mcp__hn__…` five times in five runs and failed.
