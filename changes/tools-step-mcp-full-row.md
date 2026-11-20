---
packages: @parcha/agentrun-serve
kind: fix
---
The console's Tools step lays out an MCP server's tools and the monid row across the whole width, in the same columns
as the built-in tools. They took two columns before, so on a wide window a server's tools sat in two middle columns
with empty space on both sides.
