---
packages: @parcha/agentrun-serve
kind: fix
---
When a codemode script stops at a call that waited for a person's answer, its answer now gives every call's value whole. Before, each value was cut at 2,000 characters. In QA, an approved Hacker News item of about 9 KB reached the model without its title. The whole answer is still held to the host's bound on every tool answer.
