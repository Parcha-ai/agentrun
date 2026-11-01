---
packages: @parcha/agentrun-serve
kind: fix
---
`GET /v2/settings/tool-keys` lists in each key's `unlocks` only what this server binds, as capabilities show it: the tools of `tools`, and a decision provider of `workflows.decisions.providers` as `decisions.<id>`; `harnesses` is the union of those tools' harnesses. The Parallel key no longer promises `web_search`, and the Monid key, whose tools this server does not bind, lists with an empty `unlocks`; either shows once the server binds it.
