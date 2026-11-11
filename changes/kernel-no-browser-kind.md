---
packages: @parcha/agentrun-kernel
kind: breaking
---
The kernel registry has no browser kind any more: `CapabilityKind` is `"desktop" | "phone"`, and `browserToolDefs`, `BrowserContract`, `Browser`, `CdpSession`, `Hands.browser`, `HostExecutors.browser` and `createRegistry`'s `browserTools` option are gone. A host whose computer is a browser drives it with its own browser tool (serve's, pi-browser's durable extension), and passes no browser kind, contracts or executors to `createRegistry`.
