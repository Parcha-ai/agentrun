---
packages: repo
kind: fix
---
The release fold no longer dates the changelog of a held package. A package whose manifest says `"private": true` ships nothing in a release, so its fragments are now appended to its `Unreleased` section, which keeps its name and its entries, and no version heading is written for it. Before, its entries moved under the release's version heading and the package's changelog claimed a version it did not publish. The check that no pull request edits an `Unreleased` section accepts that fold: a held package's `Unreleased` may gain exactly the bullets of the fragments the same change deletes, and any other edit is still refused.
