---
packages: repo
kind: feature
---
A template's Apply screen shows each webhook trigger's signing secret once, beside that trigger's URL, with Copy and "You won't see this secret again." The screen stays on them until you open the agent. A retry of the same apply (its Idempotency-Key) shows the server's note in place of the secrets it no longer sends. Schedule and GitHub triggers have no secret and aren't listed.
