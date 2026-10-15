---
packages: @parcha/pi-durable-disk
kind: feature
---
**`forkLocal`: fork a run on a local directory into many**
- `forkLocal(from, [{ id, root }, ...])` copies a released, sealed run directory of this machine (`localRun`) into one new
  run directory per target, with no disk and no mount: the copy `fork` makes, for one machine. Each fork starts `paused`
  at generation 0 with the source's `sealedSeq`, so its first open is generation 1, and goes on on its own.
- The source is only read and stays byte for byte; every copy is made beside its target under a temporary name and none is published until all are
  complete, so a failed batch leaves nothing behind. Targets keep the source directory's owner and mode. A source that is not released and sealed is `ForkError` `SOURCE_NOT_RELEASED`, a target that
  exists is `TARGET_EXISTS`, and a target inside the source, a repeated directory or no target is `INVALID_ARGUMENT`.
- New exports: `forkLocal` and the `ForkLocalResult` type. A run's `commands/` records are not copied.
