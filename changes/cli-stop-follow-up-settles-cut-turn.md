---
packages: @parcha/agentrun-serve
kind: fix
---
A follow-up to a Codex or Claude Code run a person stopped while a tool call ran is now the run's next turn. Before, the run first finished the stopped turn without the message, then answered the follow-up as one more turn.
