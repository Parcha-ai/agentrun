---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
An MCP tool's answers can go to the run's files instead of to the model. A template sets it per tool with `mcp[].file: {<tool>: {folder, show}}` beside `pin`, and apply writes it into the agent's own tool settings as `mcp:<server>/<tool>: {file: {folder, show}}`. Each answer that is not an error is written whole, credentials scrubbed, at `<folder>/<tool>-<time>-<id>.json` before the model gets its turn back. The model reads three lines: the answer's size and path, the value at each `show` path (at most 8, a string cut at 200 characters), and the answer's shape (keys and types to depth 2, array lengths, never a value). It never reads the rest, however long the answer: nothing of it reaches the 60,000-character clip or `evidence/mcp/`.
- If the file can't be written, the call answers an error in the Workspace's words and shows none of the answer. An answer that is an error is shown as before, so the model can react to a refusal.
- `folder` is 1 to 3 segments, none starting with a dot. A `show` path is 1 to 6 segments, each a key, an index or `-1` (the last item). A path that names a free-text field shows that text and defeats the option, so name only what the model needs to go on, such as the next page's cursor.
- The owner may change or remove the setting like any other in the agent's tool settings. With it removed, the tool's answers reach the model whole again, as before. The server's own tool settings and an MCP server's wildcard take no `file`.
- `GET /v2/templates` shows the setting on each tool that has one, and `GET /v2/agents/{id}/package` carries it back into the package's `mcp[].file`.
- An older serve refuses a package with `file` (an unknown field of its `mcp` entry), so a template that uses it needs this release.
