---
type: llm
target: draft_markdown
---
The owner's rule in force for this release: the product is an "assistant", never an "agent" and never a "bot" (it replaced the "agent, not bot" rule at v1.10.0). The message does not restate it.

Pass only if the draft says "assistant" where the PRs said "bot", and describes the same changes: answers in the asker's language (four languages); per-channel request counts on `/status`; keeps context past 100 replies (Fixed). Commands keep their exact names. PR 654 is not in the top sections. Every PR is in the table once. Nothing is added that no PR states; the owner's groups (Slack, Admin, Status) are where changes are sorted, not claims, so a change under one of them adds nothing. Fail otherwise.
