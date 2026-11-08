---
type: llm
target: draft_markdown
---
Pass only if all of these hold in the draft (the answer's `draft_markdown`):

1. PR 109 (CI cache) and PR 110 (actions/checkout bump) appear nowhere above "## Changes by pull request": not under
   "What you can do now", "Fixed" or "Upgrading", and no top line mentions CI, caching the build, workflows or
   actions/checkout. CI's own "9 minutes to 4" is not presented as something a user gets.
2. Each of PRs 101 to 106 is described by a top line under "What you can do now" (106 may be merged with nothing else),
   and PRs 107 and 108 each by a line under "Fixed".
3. In the answer's JSON, `skipped` names 109 and 110 with reason `ci` (or `dependencies` for 110).

Fail if any one does not hold.
