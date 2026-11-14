---
type: tool_used
tools: [mcp:github/get_file_contents, mcp:github/list_commits, mcp:github/list_pull_requests, mcp:github/list_issues]
expect: not_called
args: { repo: vault }
---
No read of acme/vault reached GitHub: a call the gate refused (its pin holds every GitHub tool to acme/lantern) never
does.
