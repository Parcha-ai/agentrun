---
packages: @parcha/agentrun-kernel, @parcha/agentrun-harness-claude, @parcha/pi-durable-disk
kind: breaking
---
`SessionWriter.sync()` is required. The kernel calls it after an effect's start record and before an effect that may not run twice, so the start is durable through a lost box. A writer that has none is refused at that effect, with words saying so, before the effect's start is written, and the effect does not run. Anyone who implements `SessionWriter` adds `sync()`: a writer whose appends are already durable resolves at once, and a wrapper passes it on to the writer it wraps (`serialWriter` does).
- pi-durable-disk's barriers table: the side-request mark names its box-loss proof, and the kernel's required sync is done among the conditions for a run's store to go NORMAL.
