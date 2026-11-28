---
packages: @parcha/agentrun-serve
kind: fix
---
An ACP agent's call that waits for approval (`acp_<kind>`, from Cursor or Antigravity) shows on its approval card, on the run page and on a race's page, what it runs: its command, newlines kept, or else its title. Below that come the agent's own arguments. The run's `pending.args_preview` now carries the agent's own input (`{}` when it gave none) instead of the gate's wrapper, which held `title`, `kind`, `input` and `toolCallId`. `pending.summary` carries the command or title, and a call that belongs to another MCP server starts with `Calls MCP server "<name>"`, the server the adapter recorded, on the card and on its timeline row. Both go through the run's redactor as before, so a key the server keeps, inside the agent's input, is served masked. A call that names neither a command nor a title reads as the agent's input on its timeline row, never as the wrapper.
