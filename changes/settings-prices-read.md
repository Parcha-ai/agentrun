---
packages: @parcha/agentrun-serve
kind: feature
---
`GET /v2/settings/prices` reads the prices this server meters computer and browser time at, from the same settings its meters read: each computer provider's price per vCPU-second, GiB-second of memory, GB-month of disk and GPU-second of each GPU type a setting names, and each browser provider's price an hour with its billing minimum. Each price is a decimal string with its source: `setting` (the operator's `AGENTRUN_COMPUTE_USD_PER_*` or `AGENTRUN_BROWSER_USD_PER_HOUR_*`), `list` (a built-in list price, or $0 for a provider that bills nothing) or `unpriced` (none set, or a setting that is not a plain decimal). A caller can show estimates and turn a budget of its own into the server's figures.
