---
packages: @parcha/agentrun-serve
kind: fix
---
`GET /v2/capabilities`' `features.browser` is `browserbase` when `tools[]` lists `browser` as available, and `none` when it does not. It was always `none`, so a client reading `features` hid a browser the server runs.
