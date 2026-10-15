---
packages: repo
kind: ci
---
`scripts/changes.mjs --check`, which the required `verify` job runs on pull requests and in the merge queue, fails a release commit (a workspace package version differs from the merge base's) while `changes/` holds anything but `README.md`: `release commit carries unfolded fragments: <names>; refold on current main`. The tag now always goes on the release pull request's own merge commit, with no separate fold pull request.
