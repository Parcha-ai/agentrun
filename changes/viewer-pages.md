---
packages: repo
kind: feature
---
**`apps/viewer`: the gallery is hosted on GitHub Pages**
- `.github/workflows/pages.yml` builds the viewer and publishes it to https://parcha-ai.github.io/agentrun/ on each
  push to `main` that touches `apps/viewer/`, or by hand. Its token reads the repository and writes Pages; it names no
  secret.
- It publishes nothing unless what was built passes `scripts/recording/gate.mjs`: every recording in it (a hidden one
  too) passes the recording validator; a recording holds only its manifest, its lines and blobs named by their own
  SHA-256; every published text file is free of credential shapes and machine paths; and the gallery embeds exactly the
  recordings beside it. An empty gallery fails.
- `scripts/recording/gate.test.mjs` refuses each of those; `scripts/pages-workflow.test.mjs` holds the workflow's
  triggers, permissions and step order, and runs its gate step as written.
