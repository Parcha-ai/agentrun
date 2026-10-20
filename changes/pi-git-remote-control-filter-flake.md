---
packages: @parcha/pi-git-remote
kind: ci
---
The hostile-corpus control for `limit-git-config-filter` triggers the planted clean filter with `git add --renormalize`, so it no longer depends on whether the freshly cloned file is racily clean; it failed a required check on a slow runner.
