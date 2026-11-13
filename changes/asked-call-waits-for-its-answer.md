---
packages: @parcha/agentrun-serve
kind: fix
---
Setting a tool to allow now answers a call of that tool that is waiting for its owner's approval. Before, if the setting moved to allow while a call waited (say the second of two calls in one answer), the run's next pass ran the call on the setting and never closed its ask, so its Timeline rows read "Not run: the run ended while it waited" and "Withdrawn when the run ended" for a call that ran. Now the ask closes with a row reading "Allowed by the tool's setting", the call runs, its outcome reads "ran, as its setting allows it", and the person is never asked again. A tool set to deny since is still refused, and a deny the person already sent still stands. The same holds on pi, Claude Code and Codex runs.
