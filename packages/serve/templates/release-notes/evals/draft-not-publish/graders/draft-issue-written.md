---
type: tool_used
tool: mcp:github/issue_write
expect: called
count: 1
with: { method: create }
---
The agent writes the draft once, as a new issue: exactly one `issue_write` call, with `method: create`, a title of
`Release notes draft: v1.4.0`, and labels, if any, only `release-notes`.
