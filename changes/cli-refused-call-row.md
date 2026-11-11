---
packages: @parcha/agentrun-serve
kind: fix
---
A tool call the gate refuses on a claude-agent, codex or opencode run now shows on the run's Timeline as it does on pi: the call's row, then its result's row, failed, in the gate's words (a deny set for the agent or on the server, an ask where accounts are off and no one can approve, or a person's deny of the call's approval). On the runner, the loop wrote a CLI call's record only once the gate allowed it, so a refused call had no row, though its model was told of the refusal.
- Upgrading: nothing to change.
