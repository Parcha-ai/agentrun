---
packages: repo
kind: feature
---
**`apps/viewer`: a build that ships recordings as files**
- `node apps/viewer/build.mjs --files` (or `build(target, dir, { files: true })`), off by default, writes
  `recordings/index.json` (each recording's id, manifest and blob paths) and a `gallery.js` that only points at it,
  instead of embedding every recording's lines and blobs in `gallery.js`. The page lists the gallery from the index and
  fetches a recording's lines when it is opened, its blobs at the paths the index names, with no guessing. It needs a
  static host; the default build still opens from `file://`.
