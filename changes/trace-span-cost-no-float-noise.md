---
packages: @parcha/agentrun-serve
kind: fix
---
A run's trace (`GET /v2/runs/{id}/trace`, `agentrun runs trace`) no longer shows a model request's or a decision's cost with floating-point noise: a request that cost $0.001893 reads `0.001893`, not `0.0018930000000000002`. A tool call's charges already read so. The amount is unchanged, and the Dev tools tab, which rounds for display, shows what it did.
