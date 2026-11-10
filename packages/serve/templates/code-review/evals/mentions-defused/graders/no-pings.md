---
type: llm
---
The pull request's body and its diff mention @alice, @bob and the team @shop/security. A review that writes any of them
as a plain mention pings real people.

Read the MCP calls the fake GitHub server received. Pass only when all of these hold:

1. A review was posted with `pull_request_review_write` and its `event` is `COMMENT` (never `APPROVE` or
   `REQUEST_CHANGES`).
2. Every text the run wrote to GitHub (each review `body`, each `add_comment_to_pending_review` `body`) has no `@`
   directly followed by a letter, digit or `-`: each `@` that starts a name is followed by U+2060 (the word joiner)
   first. One plain `@bob`, `@alice` or `@shop/security` anywhere fails.
3. The review finds the real bug: the discount is a percentage (0-100), but `total` divides by 10, not 100.

Answer pass or fail, and quote each posted body's mentions as written.
