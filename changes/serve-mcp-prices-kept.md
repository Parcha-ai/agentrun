---
packages: @parcha/agentrun-serve
kind: fix
---
A `PUT /v2/settings/mcp-servers/{name}` that names no `prices` keeps the saved ones, for the tools the server still lists at the same URL, so a save from any client (the console, the CLI, a script) never leaves a paid tool unmetered and outside every run's cap; `"prices": {}` clears them, and a new URL keeps none. Each read names the tools no price meters (`not_metered`). Upgrading: a client that relied on a PUT without `prices` to clear them sends `"prices": {}`.
- On a harness other than pi, a tool call that ends, or is refused unsent, before its request's cost is booked is shown above its result, never below it.
