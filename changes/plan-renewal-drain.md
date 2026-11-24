---
packages: @parcha/agentrun-serve
kind: fix
---
A server's stop no longer loses a ChatGPT plan sign-in to a renewal it cut off. OpenAI may already have spent the refresh token when the stop starts. The stop now waits up to 25 s, before the store closes, for that renewal to save its new pair. From the stop on, the server starts no new renewal. A renewal waiting on another process's lease stops waiting. When a renewal's write-back fails, the new pair is revoked only if the store refused the write unsent (it had closed). On any other failure the write may have landed, so the pair is kept and `renewed_pair_unsaved` is logged with `write=unknown`.
