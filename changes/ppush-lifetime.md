---
packages: @parcha/agentrun-computer
kind: feature
---
A machine host can now fix the two vendor timers that ended computers under a run or outlived the server: a janitor host gets a backstop time for its vendor's own delete timer, and a host whose vendor ends quiet machines declares the idle window and a keepalive.
- `MachineRequest.backstopAt`: an ISO time five minutes past the most the deadline may reach (create + `maxLifetimeMs`). A janitor host whose vendor has a delete or stop timer sets it there, so a machine still ends when the server is gone. A vendor-lifetime host ignores it.
- `HostFacts.idleMs` and an optional host member `keepalive(id, ctx)`: the adapter calls it every `idleMs / 3` from create, or attach, until release, one call at a time. A failed one is told through `onNote` and the next tries again; a machine the vendor no longer has stops it. A host with `idleMs` and no `keepalive` is refused when its provider is made, in words.
