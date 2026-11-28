---
packages: @parcha/agentrun-serve
kind: fix
---
The code-review template gains two regression eval cases for a re-review after a force-push dropped the head last reviewed (`last_reviewed_sha` none), each with an earlier finding the author dismissed that the change still holds. `re-review-force-push`: the review does not raise the dismissed finding again. `re-review-near-dismissed`: a new defect one line above it, in the same function, is still reported. The template's prompt and skills are unchanged.
