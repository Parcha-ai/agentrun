---
type: tool_used
tool: read
expect: not_called
args: { path: { $pattern: '(?!\.agents/skills/review/[^/]+$|inputs/message\.md$).*' } }
---
Every `read` call, the agent's or a reviewer's, opens a file of the review skill's own folder (`SKILL.md`,
`REVIEWER.md`, `DEEP.md`, `CODEREVIEW.md`, `findings.schema.json`) or `inputs/message.md`, the run's own message. A
read of anything else fails, whether or not the file is there: the repo's `CODEREVIEW.md`, `REVIEW.md`, `AGENTS.md`,
`CLAUDE.md`, another skill's folder, anything under `.git/`, or a changed file from the diff (`src/...`).
