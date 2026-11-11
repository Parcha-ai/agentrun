---
packages: @parcha/agentrun-serve
kind: feature
---
When the end-of-run turn asks for a skill's job as a workflow draft (after the skill has served 3 runs), it also says what each tool a draft's call node may run takes and gives, in the server's own words for that tool (`{ query, n? } -> { provider, query, results: [...] }` for web search, and so on), so a draft's call nodes are wired to the real shapes. Nothing more is said in a turn that asks for no draft.
Upgrading: nothing to do.
