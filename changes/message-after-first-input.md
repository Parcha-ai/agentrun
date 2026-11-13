---
packages: @parcha/agentrun-serve
kind: fix
---
A message sent to a run right after `POST /v2/agents/{id}/runs` answered (`POST /v2/runs/{id}/messages` before the runner had sent the run's input) now lands after the run's own input. Before, on a pi run the runner placed the message as the session's first prompt and sent the input after it: the Timeline showed the message first and the model answered the two in that order. The runner now holds such a message until the run's input is sent, then places it into that turn as any later message. Claude Code and Codex runs already ran it after the input's turn; a test now holds all three to it.
