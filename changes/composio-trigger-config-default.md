---
packages: @parcha/agentrun-serve
kind: fix
---
A package's composio trigger written with no `config` reads as `config: {}`, the config of an event whose schema needs no field (Slack's new channel): `agentrun deploy` no longer refuses it, and an apply makes, and a re-apply keeps, the trigger with the empty config. `POST /v2/triggers` still takes `config` as given; its refusal of one left out now says to send `{}` for such an event.
