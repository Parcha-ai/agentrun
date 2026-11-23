---
packages: @parcha/agentrun-serve, @parcha/agentrun-client, @parcha/agentrun
kind: feature
---
`GET /v2/runs` takes `source`: `source=claude-code` (or `codex`, ... a source's name as the run's `imported_from.source` holds it) lists only the runs imported from that source, and `source=live` the runs made here, not imported. It is the link behind "open these sessions as runs": the console's runs list keeps it in the address (`#/runs?source=claude-code`, with a button that clears it), and the CLI, the TypeScript client and the Python client send it as `--source`, `source` and `source=`. A name no run holds lists none; a second `source`, or a value that is not a lowercase name, is 400.
