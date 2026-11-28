---
packages: repo
kind: ci
---
The install walk no longer fails between a release pull request and its npm publish. This checkout's launcher pins its server at the release version, which npm doesn't have until the publish, so the install failed with `No matching version found`, and the daily walk's launcher row went red over a release still waiting for its approval. Now the walk's pack job packs this checkout's own copies of the `@parcha` packages npm lacks (`packages/agentrun/test/walk-unpublished.mjs`) and points the launcher at them. The walk says so: a notice and the job summary on the install walk, and on the daily walk's launcher row, "PASS (npm has no @parcha/agentrun-serve@… yet: walked with this checkout's packed …, not npm's)". When npm has the release, nothing changes.
