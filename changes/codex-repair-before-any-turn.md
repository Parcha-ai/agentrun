---
packages: @parcha/agentrun-codex
kind: fix
---
A call that Codex's rollout holds with no output now gets one from the log whenever a thread resumes, before any turn is sent, and not only under a recovery note. A turn that ended without answering a call (one interrupted mid-call, or settled instead of resumed) left it unanswered, and the next turn's history, with a call left open, was refused by the provider. A cut-off code-mode `exec` is answered first, as a custom tool output built from its nested calls; every other call gets the generic output.
