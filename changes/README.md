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
- `kind`: `breaking`, `feature`, `fix`, `ci` or `docs`. A breaking change says who breaks and what to do. `breaking` means a correct program written against the documented API must change (a function that took a directory now takes a file); a call that returned a wrong result silently and now fails with a typed error is a behaviour change, so `feature` or `fix`, not `breaking`.
- Omit the outer bullet and its indentation: the fold adds them. Continuation lines of the outer bullet and its immediate nested bullets start at column 0. Keep indentation within nested lists: a nested bullet's continuation lines start two spaces in.
- `node scripts/changes.mjs --check` validates the files (CI runs it). `node scripts/changes.mjs --fold <version>` is the release's one step: it turns `Unreleased` into the version's section, with the fragments after its bullets, and opens a new `Unreleased`.
