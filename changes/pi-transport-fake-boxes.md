---
packages: @parcha/pi-transport
kind: feature
---
`fakeBoxes()` in `@parcha/pi-transport/testing`: a fake box provider for testing a host against the `Box` contract with no machine, key or network. It records every call (argv, env names, stdin bytes, files, spec, typed result) and `leaks(marker)` finds a value in anything recorded. A test scripts outcomes by rule (a typed failure, a delay, a hang, a lost end of an empty stdin, a dropped or truncated stream, a scripted exit, a box that ends mid-call, a create that fails but leaves its box findable by `list`) on a `fakeClock()` that moves only when told. Programs are functions a test registers; a box's files are in memory. A scriptable launcher (`launch`, `launchState`, `launchStop` with a restart policy and stdin replayed to every incarnation) and the `modalLike()` and `daytonaLike()` presets are included; the launcher's types and the `fuse`, `startedAt` and `ptraceScope` facts are placeholders until their contracts land.
