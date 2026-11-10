---
type: llm
target: draft_markdown
---
The owner's rule in force for this release: the product is an "agent", never a "bot" (taught with v1.6.0). The message states it.

Pass only if the draft says "agent" where the PRs said "bot", and describes the same changes: replies in the thread where it was mentioned; the rate-limit retry with `Retry-After`, up to 3 times (Fixed); `/lantern mute` and `/lantern unmute` for admins; the last error on `/status`; the crash on an attachment-only message (Fixed). Commands keep their exact names. PR 605 is not in the top sections. Every PR is in the table once. Nothing is added that no PR states; the owner's groups (Slack, Admin, Status) are where changes are sorted, not claims, so a change under one of them adds nothing. Fail otherwise.
