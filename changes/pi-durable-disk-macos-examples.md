---
packages: @parcha/pi-durable-disk
kind: fix
---
**The keyless examples run on macOS, from 0.1.0-beta.14, and say so**
- kill-9's own check that the cut command still runs read `/proc`, so on macOS the example crashed after the kill. It
  reads `ps` where there is no `/proc`.
- The examples index says macOS needs 0.1.0-beta.14 or later (the first release that runs there), whatever an
  example's Since says; it no longer says "Linux only".
- The stranger's walk of the examples installs, per platform, the later of an example's Since and the spec's
  `examples.platformFloors` (macOS: 0.1.0-beta.14). Its Since alone installed 0.1.0-beta.13 on a Mac, which has no
  macOS support, and failed kill-9, audit-across-crashes and no-double-charge there.
- The macOS CI job runs the keyless example tests (kill-9, audit-across-crashes, no-double-charge, fork-into-many,
  serve-and-park) on a Mac, and its stranger step is blocking again.
