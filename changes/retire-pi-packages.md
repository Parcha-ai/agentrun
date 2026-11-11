---
packages: @parcha/agentrun-serve
kind: breaking
---
`@parcha/agentrun-pi`, `@parcha/pi-durable-disk` and `@parcha/pi-durable-agent` are no longer built or published: the server runs workflows, keeps its timeline and confines a run's files on its own code.
- A program that imports one of them keeps its last published version (0.1.0-beta.33). The server needs none of them, and installs none.
- `capabilities.runtimes` is `["runner"]`: the server's runners run every run, over its one store. It said `["pi-durable-disk"]`. The field stays informational: a run never names it.
- `preparing` is no longer sent: `capabilities.places.boxes[].state` is `ready` or `unavailable`, and the API's enum drops `preparing`. A client that checked for it removes that branch; the console's box image banner is gone with it.
