---
type: llm
target: draft_markdown
---
The owner's rule in force for this release: the product is an "agent", never a "bot" (taught with v1.6.0). The message does not restate it.

Pass only if the draft says "agent" where the PRs said "bot", and describes the same changes: `/lantern summarize`, up to 500 messages; the 20-requests-an-hour limit per user; no double post after a reconnect (Fixed); uptime on `/status`. Commands keep their exact names. PR 624 is not in the top sections. Every PR is in the table once. Nothing is added that no PR states; the owner's groups (Slack, Admin, Status) are where changes are sorted, not claims, so a change under one of them adds nothing. Fail otherwise.
