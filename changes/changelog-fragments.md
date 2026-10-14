---
packages: repo
kind: ci
---
Changelog entries are one file per pull request. A change adds `changes/<slug>.md` (front matter naming its packages and kind, then the bullet's text) instead of editing an `Unreleased` section, so two pull requests no longer collide on the top of `CHANGELOG.md`.
- `node scripts/changes.mjs --check` validates every fragment and fails a change that edits the `Unreleased` section of any `CHANGELOG.md`, unless the change is the release fold (it deletes fragments and adds none). The `verify` job runs it.
- `node scripts/changes.mjs --fold <version> [--date]` is the release's one step. In the root changelog, and in each package changelog that has fragments, it renames `Unreleased` to `## <version> (<date>)` with its existing bullets first and the fragments' bullets after them, opens a new empty `Unreleased` above it, and deletes the fragments. A fragment goes to its package's own changelog, else the root.
- `node scripts/release-preflight.mjs --tag` refuses a tag while unfolded fragments remain or the root `CHANGELOG.md` has no section for the tag's version.
