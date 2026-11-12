---
packages: @parcha/agentrun-serve
kind: breaking
---
`ServeOptions.beforeAbort`, `beforeReopenLaunch`, `hostMemory` and `onRunLoad` are gone. They were test hooks from the time runs ran in the server's own processes, and nothing has read them since runs moved to the runner. Code that passed them drops them; none of them did anything.
