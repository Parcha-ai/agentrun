---
type: llm
target: draft_markdown
---
PR 411 ("Cap webhook retries") merged into `develop` on 2026-10-05, before v1.4.1 (2026-10-10), and reached `main` in
the `Merge branch 'develop'` commit on 2026-10-20: its merge commit is reachable from v1.5.0 and not from v1.4.1, so it is
part of v1.5.0. PR 399 merged on 2026-09-28 and shipped in v1.4.1. Pass only if all of these hold:

1. The draft's top sections describe the webhook retry cap (at most 3 retries a minute) and `LANTERN_OPTS` (PR 412).
2. The table under "## Changes by pull request" has one row for PR 411 and one for PR 412, and none for PR 399.
3. The answer's JSON `pull_requests` holds exactly 411 and 412, and `range.method` is `commits`.
4. Nothing says PR 411 is out of range, or asks whether it belongs, because of its merge date.

Fail if any one does not hold.
