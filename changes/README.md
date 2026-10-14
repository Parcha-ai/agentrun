# Changes

One file per pull request, named for the change (`changes/<slug>.md`, lowercase letters, digits and dashes). The release folds the files into the changelogs and deletes them; no pull request edits an `Unreleased` section.

```md
---
packages: @parcha/agentrun-pi
kind: feature
---
What changed and what a user does differently, as the text of one changelog bullet (no leading "- ").
Sub-bullets and further paragraphs go below it.
```

- `packages`: one or more workspace package names, comma separated, or `repo` for the repository as a whole. A package with its own `CHANGELOG.md` gets the bullet there; every other one gets it in the root `CHANGELOG.md`.
- `kind`: `breaking`, `feature`, `fix`, `ci` or `docs`. A breaking change says who breaks and what to do.
- `node scripts/changes.mjs --check` validates the files (CI runs it). `node scripts/changes.mjs --fold <version>` is the release's one step: it turns `Unreleased` into the version's section, with the fragments after its bullets, and opens a new `Unreleased`.
