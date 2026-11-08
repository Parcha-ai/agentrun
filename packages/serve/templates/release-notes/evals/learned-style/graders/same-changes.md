---
type: llm
target: draft_markdown
---
Pass only if the draft says "agent" where the PRs said "bot", and otherwise describes the same changes: replies in
threads (601), the rate-limit retry with `Retry-After` up to 3 times (602, under Fixed), `/lantern mute` and
`/lantern unmute` for admins (603), the last error on `/status` (604), and the crash on an attachment-only message
(606, under Fixed). The slash commands keep their exact names. PR 605 (CI) is not in the top sections. Nothing is added
that no PR states. Fail otherwise.
