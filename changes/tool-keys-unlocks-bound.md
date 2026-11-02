---
packages: @parcha/agentrun-serve
kind: fix
---
`GET /v2/settings/tool-keys` lists in each key's `unlocks` only what this server binds, as capabilities show it: the tools of `tools`, and a decision provider of `workflows.decisions.providers` as `decisions.<id>`; `harnesses` is the union of those tools' harnesses. The Parallel key no longer promises `web_search`; a name in the key table shows once the server binds it, as the monid tools do on pi.
