---
packages: repo
kind: fix
---
**`apps/viewer`: a build skips a blob still being written**
- A recorder writes a blob as `.<sha>.<ext>.tmp-<pid>` and renames it once whole, so a copy of a recording taken while it
  goes may hold such a name in `blobs/`. `build.mjs` neither lists it in the gallery (embedded or `--files`) nor copies
  it, so the build of such a copy passes the hosted gallery's gate.
