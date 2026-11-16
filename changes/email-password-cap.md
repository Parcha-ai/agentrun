---
packages: @parcha/agentrun-serve
kind: fix
---
The OpenAPI document capped the email account's password at 320 characters while the server took 1,024. Both now read one cap, 1,024, so a long OAuth-style token is valid in the document too. The tool catalog's email tool summaries are now the tools' own descriptions, so `email_send`'s says `rejected` and `note`.
