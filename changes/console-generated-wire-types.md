---
packages: repo
kind: fix
---
The console reads the server's answers through the types generated from the server's OpenAPI document, in place of its own copies: an agent and its definition, a runs list's items (which carry no result), an agent's learning, stats, MCP servers, capabilities, uploads, a run's start, and the list and small answers its client reads. Nothing a person sees changes. A runs list's items, typed as full runs before, are now the summaries the server sends.
