---
packages: @parcha/pi-durable-disk
kind: docs
---
**An example: fork one run into many**
- `examples/fork-into-many` runs on directories of this machine with pi-ai's faux model (no disk, no key, Linux). An agent
  drafts a note and the run is released at that checkpoint; `forkLocal` copies the sealed run three times, and each fork
  opens as generation 1 with the checkpoint's conversation and files, takes its own instruction and finishes. The source stays
  byte for byte. It ends with one `ok:` line, and `test/examples/fork-into-many.test.ts` runs it on every change.
