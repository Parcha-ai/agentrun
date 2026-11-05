---
packages: repo
kind: ci
---
`node scripts/changes.mjs --check` on a merge whose first parent holds the given base compares with that first parent: on CI, the base branch GitHub's test merge was made on, not the pull request event's base SHA, which can be older. A release no longer fails every open pull request's check as "release commit carries unfolded fragments" (seven of the first ten pull-request runs after beta.29 did). A commit that is not a merge, or a restack merge, is compared with the base given, as before.
