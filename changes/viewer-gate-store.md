---
packages: repo
kind: feature
---
**The hosted gallery's gate scans a recording's store**
- A recording's store (draft 24: a SQLite file its manifest names) is binary, so the gate's text scan never read it.
  `scripts/recording/gate.mjs` now reads it byte for byte for the same credential shapes and machine paths, refuses a
  store over 10 MB, and refuses a manifest that names a store `blobs/` does not hold.
