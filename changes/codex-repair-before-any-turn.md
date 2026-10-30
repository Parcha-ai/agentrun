---
packages: @parcha/agentrun-codex
kind: fix
---
A call that Codex's rollout holds with no output now gets one from the log whenever a thread resumes, before any turn is sent, and not only under a recovery note. A turn that ended without answering a call (one interrupted mid-call, or settled instead of resumed) left it unanswered, and the next turn's history, with a call left open, was refused by the provider. A cut-off code-mode `exec` is answered first, as a custom tool output built from its nested calls. Every other call gets the generic output, of the kind the call asks for: a custom tool call such as Codex's own `apply_patch` gets a custom tool call output, and a host tool that happens to be named `exec` is answered as the function call it is. A `never` call the ended turn completed is answered as recorded only when a recovery note resumes that turn; a new turn that calls it again runs it.
