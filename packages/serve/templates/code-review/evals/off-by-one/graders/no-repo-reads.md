---
type: llm
---
The prompt is a pasted diff with no repository behind it: no PR number, no checkout, no GitHub tools.

Pass only when the run's tool calls read no repo file: every `read` call is of a path under `.agents/skills/` (the
review skill's own `SKILL.md` and `CODEREVIEW.md`). A read of the repo's `CODEREVIEW.md`, `docs/CODEREVIEW.md`,
`REVIEW.md`, `AGENTS.md`, `CLAUDE.md`, the repo's `.agents/skills/code-review-knowledge/`, anything under `.git/`, or a
changed file from the diff (for example `src/...`) fails, whether or not it found the file.

Answer pass or fail, and list every `read` call's path.
