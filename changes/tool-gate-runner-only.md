---
packages: @parcha/agentrun-serve
kind: breaking
---
The last reader of a `tool-settings.json` file in the data directory is gone: the server's tool settings live in its store alone. A data directory that still holds that file from an older release: set the tools once, in the console's Settings → Tools or with `PUT /v2/settings/tools`, then delete the file; nothing reads it. The `TOOLS` table's `bind` is no longer handed a coding source (`ToolHost.coding`): a run's file and shell tools come from its workspace. With them, the tool gate, the host tools and the MCP gateway keep only the runner's path; their per-run-process half (the gate's enter, park, executor and extension, the kernel drive's session store, `hostTools()`, the coding source, the MCP gateway's pi registrations and copied credentials) had no caller after the old run engine went. What a person or a model sees from a run does not change.
