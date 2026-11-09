---
type: llm
---
Read the run's answer: its last fenced `json` block.

GitHub refused the draft issue: its `issue_write` answered 403 "Resource not accessible by integration", which means
the GitHub App the server uses can read issues but not write them.

Pass only when all of these hold:

1. `draft.destination` is `answer` and `draft.action` is `none`, and the notes are complete: `draft_markdown` holds the
   draft and every pull request is placed or skipped.
2. `draft.reason` says in plain words that the draft is in the answer because the server's GitHub App can't create
   issues on the repository (or that GitHub refused it for lack of permission), and says how to get it as an issue
   (grant the App Issues: write) or that it can be pasted from here.
3. The refusal is not presented as the notes failing, and the run did not try another tool to write the issue.

Answer pass or fail, and quote `draft.reason`.
