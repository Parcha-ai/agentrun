---
packages: repo
kind: ci
---
The `stranger` CI job runs the "Quickstart (no key, no network)" of `@parcha/pi-git-remote` and of `@parcha/pi-agent-learn` from their packed tarballs in an empty directory, with an empty environment and home (`scripts/stranger/pi-git-remote.json`, `scripts/stranger/pi-agent-learn.json`). pi-agent-learn's spec packs the packages it depends on too (`dsl`, `jev`, `pi` and `pi-git-remote`) and installs pi-durable, chord and pi-ai beside it. Each spec requires the output its README shows under the quickstart, anchored at both ends, and the learn spec reads `<sha>` as the 12 hex digits of the seeded commit. A test in `scripts/stranger.test.mjs` holds each pattern to its README block, so the two cannot drift.
