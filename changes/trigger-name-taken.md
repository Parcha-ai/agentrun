---
packages: @parcha/agentrun-serve
kind: feature
---
A trigger's name is unique per agent: `POST /v2/triggers`, or a `PATCH` that renames, with a name the agent's other trigger already has answers `409 name_taken` ("This agent already has a trigger named <name>.").
