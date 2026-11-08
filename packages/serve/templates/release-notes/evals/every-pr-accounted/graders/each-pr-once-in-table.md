---
type: llm
target: draft_markdown
---
Look only at the table under "## Changes by pull request" in the draft. Pass only if it has exactly one row for each of
PRs 401, 402, 403, 404, 405, 406, 407, 408, 409 and 410: none missing, none twice, and no row for any other number. Each
row links its PR (`https://github.com/acme/lantern/pull/<n>`). Also check the answer's JSON: `pull_requests` holds the
same ten numbers, once each. Fail otherwise.
