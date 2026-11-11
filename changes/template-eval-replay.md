---
packages: @parcha/agentrun-serve
kind: feature
---
`agentrun-serve eval-template` can replay recorded data for a case: a fake MCP server's answer may name a list of `when` mappings (any one matching), a tool may answer calls no answer matches with `search`, a code search over files the fixture holds (`path:line: text`), and a package's `evals/` files are bounded at 32 MiB each instead of the agent's 256 KiB / 1 MiB. The JSON report keeps each run's answer, tool calls, MCP calls and start and end times, so a caller can score a run after the eval's server is gone.
