---
packages: @parcha/pi-durable-disk
kind: docs
---
The README and `docs/reference.md` say that an instance ends after its app releases the run: returning from `onOpen` after
`await run.release()` is enough, and the examples' `process.exit(0)` is fine too. This follows the fix that makes such an
instance exit 0 and a stop after the release clean.
