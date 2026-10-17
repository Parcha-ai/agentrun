---
packages: repo
kind: fix
---
`changes.mjs --fold` writes the same held-package changelog when a release folds in two commits as when it folds once. A held package's Unreleased section keeps what it had; the bullets of this release's fragments follow it in the fold's order (kind, then file name). When a release folds, merges main and folds a late fragment again, the earlier fold's run is rebuilt from the merge base's text with the late fragments in that order, so `--check` accepts it. `--base <ref>` (default `origin/main`) names what the merge base is taken against; a section that is not an earlier fold's exact output is left as it was and the new bullets are appended after it.
