---
packages: @parcha/agentrun-serve, @parcha/agentrun
kind: feature
---
`GET /v2/templates/marketplace` (serve's `marketplace/1`) answers the list marketplace.agentrun.ai publishes (GRE-4834), each entry with `here`, the id of the package on this server that it is. The server reads it only when a page or a caller asks, keeps it 5 minutes, keeps the last good list through a failed read (`stale`), and answers `unreachable` with an empty list when no read has worked, always with a 200. Each entry is checked field by field; nothing on it is imported or run. An entry carries its `source` (the package an install reads, pinned to a commit) and its package's `harness` preference list when the list gives them. `agentrun local list-marketplace-templates` reads the same list.
- `AGENTRUN_MARKETPLACE=off` reads no marketplace; an https address (http on loopback) reads that site's list; any other value stops the start. Under `--faux` it is off unless it names an address. A service keeps it: `agentrun service install --env AGENTRUN_MARKETPLACE=off` (or an address), and `AGENTRUN_MARKETPLACE=` removes it.
- Failure behavior: the read takes at most 10 s, 4 MiB and 1000 entries and follows no redirect; a failed read is retried after a minute, not on every page.
