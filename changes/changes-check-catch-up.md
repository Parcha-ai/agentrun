---
packages: repo
kind: ci
---
`node scripts/changes.mjs --check` no longer reads a package that catches up to the workspace version as a release commit: a package whose manifest moves to the version the root `package.json` already holds at the merge base (one added behind the others, as `@parcha/agentrun-computer` was at 0.1.0-beta.30) is an ordinary pull request, and a fragment beside it passes. A release moves the root version too, so its bumps still count, and an unfolded fragment on one is still refused.
