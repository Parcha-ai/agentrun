---
type: tool_used
tool: mcp:github/list_commits
expect: called
args: { sha: "2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b" }
---
The agent walks the previous release's history too (`list_commits` from v1.4.1's commit), so the range is the commits
reachable from v1.5.0 and not from v1.4.1, not those dated after v1.4.1.
