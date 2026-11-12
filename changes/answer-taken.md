---
packages: @parcha/agentrun-serve
kind: fix
---
A second answer to one tool call's approval is refused by the store as `AnswerTaken`, on SQLite and on Postgres alike, matched by the one-answer index's name (`commands_one_answer`). Before, it was a bare `StoreConstraint`, and the server read back the winning answer for any constraint error. Now an approve that lost a race is the same 409 `not_continuable` (`details.reason: already_answered`, the winner's decision) as one sent after, and a person's message that loses to an approve goes on as a plain message. Any other constraint error is no longer mistaken for an answered call.
