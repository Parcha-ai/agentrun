---
packages: @parcha/pi-durable-disk
kind: docs
---
**A quickstart on one machine: no disk, no key**
- The README opens with a durable chat on a directory of this machine (`localRun`) and pi-ai's faux model: one process
  is killed (`SIGKILL`) after its third answer, a second opens the same run and answers the rest, and the transcript read
  back from the store has every message answered once. It is `examples/01-durable-chat/on-a-directory.mjs`.
- The stranger test installs the packed package and its peers in an empty directory, runs the README's script and
  expects that line, so the quickstart a reader copies is the one that is checked.
