---
packages: repo
kind: ci
---
The release workflow folds the changelog fragments its tag carries after it builds computerd, so the published daemon's build info no longer reads `+dirty` when a pull request merged between the release pull request's fold and the tag.
