---
packages: @parcha/agentrun-serve
kind: feature
---
An agent can cap its runs' requests on free models with `definition.max_requests` (a whole number; 0 clears it). A run stops at the lower of it and `AGENTRUN_FREE_MODEL_REQUESTS`, failed with `spend_cap_reached`. A template sets it with `budget.max_requests`.
