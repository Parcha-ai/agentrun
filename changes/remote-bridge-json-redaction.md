---
packages: @parcha/agentrun-serve
kind: fix
---
Redact remote native payload values before serializing JSON replies, preserving request and session identities even for long minified tool output. Credentials remain hidden in text, numbers and property names without running payload getters or serialization hooks.
