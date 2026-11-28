---
packages: @parcha/agentrun-serve
kind: fix
---
The code-review-composio template gains a regression eval case, `re-review-force-push`: a pull request reviewed once at a head it was since force-pushed away from, with an open P1 the change still has and a P2 the author declined. A passing run posts one review at the new head, with no inline repost of either finding, no new finding for either, and a body that names the P1 only as still open. The template's prompt and skills are unchanged.
