---
packages: @parcha/agentrun-serve
kind: fix
---
A workflow's call and model nodes fail closed when the server's tool settings can't be read, as an agent's calls do: with no good read yet, every tool asks, so a call node is refused ("needs a person's approval, which a workflow's call node cannot wait for") instead of running on the revision's own allow over a deny the server holds; after a good read, that read is kept and its denies still refuse.
