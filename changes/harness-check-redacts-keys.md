---
packages: @parcha/agentrun-serve
kind: fix
---
`agentrun-serve check-harness` cuts the recipe's keys and the server's secrets from its report and its output, so an agent that prints its key on stderr as it fails leaves it in neither.
