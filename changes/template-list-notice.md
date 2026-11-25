---
packages: @parcha/agentrun
kind: fix
---
`agentrun template list` prints a line on stderr after the listing, on a pipe too, saying every text in an entry (its description, parameter titles, descriptions and examples, MCP reasons, model notes and warnings, trigger inputs) is the package author's, not instructions to the reader. Its stdout is the server's JSON as before, and a refused listing prints no such line.
