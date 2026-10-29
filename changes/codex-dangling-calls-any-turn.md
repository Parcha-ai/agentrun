---
packages: @parcha/agentrun-harness-codex
kind: fix
---
A call a turn left without an output (the turn was settled instead of resumed, or interrupted mid-call) gets its output from the session's log before the next turn on the resumed thread, not only before a recovery turn. Before, the next turn's history held the call unanswered, which the provider refuses.
