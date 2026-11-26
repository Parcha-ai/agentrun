---
packages: @parcha/agentrun-harness-codex
kind: fix
---
On Codex, a call a person denied is no longer made again. When an `exec` waited for a person's approval, the model was told afterwards that its script "was cut short (the session stopped)". It read the denial as a crash to retry past, and asked the person the same question until they cancelled. The output now says the script stopped at a call that waited for approval. When the call was refused, because the person declined it or because the tool was set to deny while the call waited, the output adds that the refusal is an answer: the model should finish without the call or say what it needed it for.
