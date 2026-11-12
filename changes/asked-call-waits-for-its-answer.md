---
packages: @parcha/agentrun-serve
kind: fix
---
A tool call a person was asked about waits for their answer even if the tool's setting changes to allow in the meantime, and its Timeline rows say what happened. Before, if the setting moved to allow while a call waited (say the second of two calls in one answer), the run's next pass ran the call on the setting and never took the person's Allow. The call ran, but its rows read "Not run: the run ended while it waited" and "Withdrawn when the run ended". Now it runs on the person's Allow: its approval row reads "Asked your approval", its outcome "web_fetch ran once you allowed it", and its result row holds the real result. A Deny still refuses it, and a tool set to deny since is still refused first. The same holds on pi, Claude Code and Codex runs.
