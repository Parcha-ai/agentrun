---
packages: repo
kind: fix
---
`docs/dependencies.md` counts the copies a package resolves inside its own workspace directory. `scripts/export-source.mjs` recorded only root-level lockfile locations, so a package whose dependencies or peers resolve to workspace-local copies dropped out of their rows: 7 package/version pairs were missing (248 listed, 255 now), all permissive.
