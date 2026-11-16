---
packages: @parcha/agentrun-computer
kind: feature
---
A janitor host now gets a backstop time for its vendor's own delete timer, so a machine still ends when the server is gone.
- `MachineRequest.backstopAt`: an ISO time five minutes past the most the deadline may reach (create + `maxLifetimeMs`). A janitor host whose vendor has a delete or stop timer sets it there. A vendor-lifetime host ignores it.
