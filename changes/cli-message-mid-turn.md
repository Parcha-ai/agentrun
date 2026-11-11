---
packages: @parcha/agentrun-serve
kind: fix
---
A message sent to a claude-agent, codex or opencode run while it is working is no longer lost. The API accepted it (202, mode `follow_up`), but the runner then refused it because these harnesses take no message mid-turn. Now each such message is sent as a turn of its own once the current turn ends, in the order they came, and shows on the run's timeline. A pi run still takes it mid-turn, as before.
- Upgrading: nothing to change.
