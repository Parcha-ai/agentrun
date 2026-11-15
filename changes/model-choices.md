---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
A template package can offer up to three named model choices (`model.choices`), each a model on one of its harnesses with an optional warning and setup note, and the owner picks one at install. `POST /v2/templates/{id}/apply` takes `overrides.choice: <id>` and runs the agent on exactly that model and harness, or refuses: an unknown id, or a choice sent with `overrides.model`, is `422 overrides.choice`; a choice's missing key is `409 agent_not_runnable`, as a package's is; a model this server can't run on that harness is `409` naming the model, never the tier's model in its place. `GET /v2/templates` lists the choices under `model.choices`.
- The console's install form shows one Model group when a package offers choices: its default first, then each choice by label, each warning and note shown word for word under it, and sends the pick as `overrides.choice`. A package with no choices shows no group.
