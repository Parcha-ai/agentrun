---
type: llm
target: draft_markdown
---
The owner's rule in force for this release: the product is an "assistant", never an "agent" and never a "bot" (it replaced the "agent, not bot" rule at v1.10.0). The message states it.

Pass only if the draft says "assistant" where the PRs said "bot", and describes the same changes: `/lantern ticket` opens a Jira ticket; `/lantern allow #channel` for admins; the crash on a user with no display name (Fixed). Commands keep their exact names. PR 644 is not in the top sections. Every PR is in the table once. Nothing is added that no PR states; the owner's groups (Slack, Admin, Status) are where changes are sorted, not claims, so a change under one of them adds nothing. Fail otherwise.
