---
packages: repo
kind: fix
---
An agent's page lists its saved browser sign-ins (GET /v2/agents/{id}'s `sign_ins`): a row per vendor with its state and when it was last verified, and never the pointer. Forget removes every vendor's sign-in under a key (DELETE /v2/agents/{id}/sign-ins/{key}), names each vendor's result, and waits while a run holds the sign-in (409 `sign_in_held`, the run named).
