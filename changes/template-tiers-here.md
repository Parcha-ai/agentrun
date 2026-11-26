---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: fix
---
GET /v2/templates and GET /v2/templates/{template} give each package's `model_tiers_here`: the harness an apply here would make its agent on, and the model its `fast` and `strong` subagents would run on there, null where this server would not use the package's (behind a model gateway, or a model it can't run), with apply's warning as `note`. The console's Free shelf reads it, so on a server behind a model gateway it no longer lists a template as free whose subagents bill on the host's models.
