---
packages: @parcha/agentrun
kind: fix
---
`agentrun api` refused a secret write (`403`) with only its status: it now also says that a secret is saved, replaced or removed only from the owner's signed-in session in the console, and that the API token can't write one. The server's answer stays unprinted, since it could quote the secret sent.
