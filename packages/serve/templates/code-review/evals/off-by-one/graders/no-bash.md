---
type: tool_used
tool: bash
expect: not_called
---
The prompt is a pasted diff with no repository behind it: no PR number, no checkout, no GitHub tools. The run makes no
`bash` call at all (no clone, no `git`, no `grep`, no `ls`), the agent's or a reviewer's.
