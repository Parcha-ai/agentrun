---
packages: @parcha/agentrun-serve
kind: fix
---
The dashboard and agent analytics show Input and Output counts beneath the token total. Input includes cached tokens, including when a connected source reports total and output usage without a cache breakdown. Missing counts display a dash, and genuine zero counts remain zero. The token card no longer shows cache percentages or model-request diagnostics; incomplete coverage and history limits remain visible.
