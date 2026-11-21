---
packages: @parcha/agentrun-serve
kind: fix
---
A backend SDK run's compile ask now stops at the agent's own max_requests on a free model, as every other run of the agent does, when that is under the server's AGENTRUN_FREE_MODEL_REQUESTS.
