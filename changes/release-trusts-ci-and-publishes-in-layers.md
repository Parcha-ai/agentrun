---
packages: repo
kind: ci
---
The release workflow no longer runs `npm run check` on the tagged commit: it requires the `verify (<node>)` gates of `ci.yml`'s push run on `main` for that commit to have passed (`scripts/release-ci-gate.mjs`) and stops on anything else, then builds and runs the checks that make the published archives (generated files, author contract, package and source verification, preflight). It publishes in dependency layers (`releaseLayers` in `scripts/release-preflight.mjs`): each layer is published, then every package of it is verified against the registry at once, and a failure stops the release before the next layer.
