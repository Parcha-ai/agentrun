---
packages: repo
kind: ci
---
A release no longer waits for, or refolds after, a pull request that merges beside it. The merge queue could put pull requests ahead of the release pull request after its changelog fold; their code reached the tag with their `changes/` fragments unfolded, and `release-preflight` refused that tag, so beta.33 took two extra fold pull requests. Now the release workflow runs `node scripts/changes.mjs --fold <version>` at the tag, uncommitted, before it builds or packs anything, so the published changelogs list everything the archives ship. `release-preflight` requires the working tree to be the tag plus exactly that fold, recomputed from the tag's own files, where it required a clean tree. The next release pull request's `--fold` puts a fragment the previous release's tag carried into that release's section, under its date, so main's changelogs say what each release published.

- `changes.mjs --check` no longer fails a release commit that carries a fragment (`release commit carries unfolded fragments`), which also failed pull requests branched before a release whose CI compared against a stale base.
- `changes.mjs --fold` drops `--base` and its rebuild of a release folded in two commits: a release pull request no longer refolds. `--date` defaults to the date the root changelog already gives the version.
