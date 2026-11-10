---
packages: @parcha/agentrun-serve
kind: fix
---
The server image has `agentrun-serve` on its PATH, so the sign-in page's "Forgot it?" command (`agentrun-serve reset-password --data /data`)
works as written in the image's shell, Render's Shell included. Before, it answered "command not found" (#2225).
