---
packages: @parcha/pi-durable-disk
kind: fix
---
**The examples that keep an instance busy run on macOS too**
- The macOS CI job now runs the kill-9, audit-across-crashes, no-double-charge, fork-into-many and serve-and-park example
  tests on a Mac. 0.1.0-beta.14 passed the quickstart there, but three examples failed against it on macOS only.
