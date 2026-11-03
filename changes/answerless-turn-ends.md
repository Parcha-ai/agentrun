---
packages: @parcha/agentrun-serve
kind: fix
---
A run whose follow-up turn ends without showing an answer now ends completed, its answer the earlier one. The Claude CLI's `/compact` is one such turn: a summary request and no text. Before, the run sat `working`/`idle` until another message came, because serve ended a run only when its newest row was an answer. serve now notes the newest entry the run's door had sent when it said a turn was over. A person's message at or before that entry was taken by a turn that is over. A message whose turn hasn't ended still waits.
