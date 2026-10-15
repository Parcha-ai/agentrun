---
packages: repo
kind: ci
---
**The hosted gallery ships its recordings as files**
- `.github/workflows/pages.yml` builds the viewer with `--files`: the recordings are published as files with
  `recordings/index.json`, and the page fetches a run only when it is opened, instead of loading every run's lines and
  blobs in `gallery.js`.
- `scripts/recording/gate.mjs` checks a files build: `recordings/index.json` lists exactly the recordings beside it,
  and the index is the only file beside the recordings.
- The gate holds every gallery entry, in either build, to exactly what its recording's files give, since the page plays
  the gallery's copy: the same manifest as its `manifest.json`, every blob in its directory and no other, each under its
  own SHA-256 (a files build names the blob's path; an embedded one carries its bytes, which must be the file's), and,
  embedded, the same lines as its `events.jsonl`. A swapped, missing or extra blob, another manifest or other lines are
  refused.
