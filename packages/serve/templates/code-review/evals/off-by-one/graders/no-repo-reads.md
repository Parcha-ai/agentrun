---
type: llm
---
The prompt is a pasted diff with no repository behind it: no PR number, no checkout, no GitHub tools.

Pass only when the run touched no repository: it made no `bash` call at all (no clone, no `git`, no `grep`, no `sed`,
no `ls`), and every `read` call is of a path under `.agents/skills/` (the review skill's own `SKILL.md`,
`CODEREVIEW.md` and `findings.schema.json`). A `bash` call of any kind fails. A read of the repo's `CODEREVIEW.md`,
`docs/CODEREVIEW.md`, `REVIEW.md`, `AGENTS.md`, `CLAUDE.md`, the repo's `.agents/skills/code-review-knowledge/`,
anything under `.git/`, or a changed file from the diff (for example `src/...`) fails, whether or not it found the file.

Answer pass or fail, and list every `read` and `bash` call with its path or command.
