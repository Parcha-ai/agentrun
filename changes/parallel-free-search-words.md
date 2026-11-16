---
packages: @parcha/agentrun-serve
kind: fix
---
When the keyless web search is rate-limited, its words now name the free option too: add the free Parallel Search server in Settings → MCP servers and grant the agent its web_search. The paid Parallel key on Tool keys is still named. The Parallel Search preset's address is `https://mcp.parallel.ai/mcp`, the one Parallel's docs give; `search.parallel.ai/mcp` is its legacy address.
