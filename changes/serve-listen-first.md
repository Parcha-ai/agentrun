---
packages: @parcha/agentrun-serve, @parcha/agentrun
kind: fix
---
AgentRun Server binds its port and prints `Starting <url>/` before it loads the rest of itself, so a start on a slow or loaded disk names its address in seconds, not minutes. Until it is ready it answers that it is warming: `GET /v2/health` is `503` with `status: "warming"` and `checks.store: "opening"`, the API answers `503 unavailable` with a `Retry-After`, and a browser gets a page that reloads itself. On a cold disk, a request sent while the server's modules load is answered once they have. Then the banner prints as before, and its `Open ` line still means ready.
`npx @parcha/agentrun` takes the `Starting` line as the server listening: it names the address on stderr at once, and its start bound (60 s, or `AGENTRUN_START_TIMEOUT_MS`) no longer stops a server that is up and still loading. A start that does pass the bound says so and names `AGENTRUN_START_TIMEOUT_MS`.
A port already taken when the server starts is left to the start's own wait, as before, so a restart still waits for the server it replaces and takes its port.
