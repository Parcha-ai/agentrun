---
packages: @parcha/agentrun-client, repo
kind: fix
---
The TypeScript and Python clients cut the server's reason in a refusal message by one rule. Each run of whitespace becomes one space, and control, zero-width and bidi characters are dropped.
