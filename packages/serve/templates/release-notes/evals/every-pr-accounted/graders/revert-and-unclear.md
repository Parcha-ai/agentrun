---
type: llm
target: draft_markdown
---
Pass only if all of these hold above "## Changes by pull request" in the draft:

1. Nothing says webhooks are retried or back off: PR 401 was reverted by PR 403 in the same range, so neither is a
   user-facing change. (In the table, both are marked as reverted.)
2. Nothing describes a spinner change as if it were known what it does: PR 410 has no description, so it is not in the
   top sections. The answer's `questions` asks about PR 410.
3. PRs 405, 406, 407 and 408 (docs typo, tests, refactor, patch bump) are not in the top sections.
4. PRs 402 and 409 are under "What you can do now", PR 404 under "Fixed".

Fail if any one does not hold.
