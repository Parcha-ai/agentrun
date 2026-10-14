---
packages: repo
kind: ci
---
Changelog entries are one file per pull request. A change adds `changes/<slug>.md` (front matter naming its packages and kind, then the bullet's text) instead of editing an `Unreleased` section, so two pull requests no longer collide on the top of `CHANGELOG.md`.
- `node scripts/changes.mjs --check` validates every fragment and fails a change that edits the `Unreleased` section of any `CHANGELOG.md`, unless the change is the release fold (it deletes fragments and adds none). The `verify` job runs it.
- `node scripts/changes.mjs --fold <version>` moves each fragment's bullet into the changelog its package names (the package's own if it has one, else the root) under the version's heading, and deletes the fragment. The existing `Unreleased` bullets are not touched.
- `node scripts/release-preflight.mjs --tag` refuses a tag while unfolded fragments remain or the root `CHANGELOG.md` has no section for the tag's version.
