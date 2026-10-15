---
packages: repo
kind: ci
---
**The hosted gallery ships its recordings as files**
- `.github/workflows/pages.yml` builds the viewer with `--files`: the recordings are published as files with
  `recordings/index.json`, and the page fetches a run only when it is opened, instead of loading every run's lines and
  blobs in `gallery.js`.
- `scripts/recording/gate.mjs` checks a files build: `recordings/index.json` lists exactly the recordings beside it,
  each blob path is a blob inside its own recording, and the index is the only file beside the recordings.
