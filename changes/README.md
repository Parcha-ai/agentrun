# Changes

One file per pull request, named for the change (`changes/<slug>.md`, lowercase letters, digits and dashes). The release folds the files into the changelogs and deletes them; no pull request edits an `Unreleased` section.

```md
---
packages: @parcha/agentrun-dsl
kind: feature
---
What changed and what a user does differently, as the text of one changelog bullet (no leading "- ").
Sub-bullets and further paragraphs go below it.
```

- `packages`: one or more workspace package names, comma separated, or `repo` for the repository as a whole. A package with its own `CHANGELOG.md` gets the bullet there; every other one gets it in the root `CHANGELOG.md`.
- `kind`: `breaking`, `feature`, `fix`, `ci` or `docs`. A breaking change says who breaks and what to do. `breaking` means a correct program written against the documented API must change (a function that took a directory now takes a file); a call that returned a wrong result silently and now fails with a typed error is a behaviour change, so `feature` or `fix`, not `breaking`.
- Omit the outer bullet and its indentation: the fold adds them. Continuation lines of the outer bullet and its immediate nested bullets start at column 0. Keep indentation within nested lists: a nested bullet's continuation lines start two spaces in.
- `node scripts/changes.mjs --check` validates the files (CI runs it). It refuses a fragment a release already folded, whose marker or exact bullet a released section holds: delete it with `git rm`. `node scripts/changes.mjs --fold <version>` is the release's one step: it turns `Unreleased` into the version's section, with the fragments after its bullets, and opens a new `Unreleased`. A `breaking` fragment goes under the section's `**Breaking:**` heading, which the fold opens at the top of a section that has none (the rest then under `**Changes:**`). A fragment whose pull request merged after the release pull request's fold, before the tag, ships in that release anyway: the release workflow folds it at the tag, and the next release's fold puts it into that release's section (see [docs/releasing.md](../docs/releasing.md#the-changelog-fold)).
- Every bullet the fold writes ends its first line with the fragment's marker, `<!-- changes/<slug>.md -->`: that is how a section says it holds a fragment, never the bullet's words. To rewrite a folded bullet in a released section by hand, change the words and keep the marker in the entry; an entry that tells two fragments carries both markers. GitHub and the website hide the marker, and the release notes and the Slack post take it out.
