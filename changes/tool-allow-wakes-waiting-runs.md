---
packages: @parcha/agentrun-serve
kind: fix
---
Setting a tool to allow now ends a run's wait on that tool at once. A run waiting for its owner's approval of a call went on only when someone answered it (or sent the run another message), even when the tool's setting had moved to allow since. Now `PUT /v2/settings/tools` wakes every run waiting on a call whose tool reads allow for that run, with its agent's own tool settings over the server's: the call runs, and its approval row reads "Allowed by the tool's setting". A run whose agent still sets the tool to ask, or whose tool still reads ask or deny, keeps waiting for its person. The same holds on pi, Claude Code and Codex runs.
