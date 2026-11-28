---
packages: @parcha/agentrun
kind: fix
---
`agentrun race start` starts its lanes on a server that does not serve `GET /computers` to a request in a workspace (403, reason `not_scoped`; a hosted install before it did). The lanes get no runner shell there, as on a server whose runner runs none. Before, the race stopped before any lane with "No lane was started". Any other refusal of that read still stops the race, and its words no longer end in a doubled period.
