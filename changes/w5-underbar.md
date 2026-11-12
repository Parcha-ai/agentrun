---
packages: @parcha/agentrun-kernel
kind: breaking
---
`@parcha/agentrun-kernel/host` no longer exports the types `BoxRecorder` and `Reaped`; nothing in the repo used them. A host that imported either declares its own shape.
