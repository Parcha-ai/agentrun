---
packages: @parcha/agentrun-serve
kind: fix
---
Applying a template that grants `issue_write` on a GitHub App whose installation has only Issues: read now warns that GitHub refuses it on a private repository, and says a public repository takes it anyway. The warning said GitHub always refuses it, but on a public repository anyone who can read it may open an issue, App tokens included, so release-notes opened its draft issue there.
