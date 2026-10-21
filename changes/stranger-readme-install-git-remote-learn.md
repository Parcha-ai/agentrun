---
packages: repo
kind: ci
---
The stranger specs for `@parcha/pi-git-remote` and `@parcha/pi-agent-learn` name their README's install line (`readmeInstall`), as pi-vision's does. `scripts/stranger.test.mjs` now checks that each line installs its package and reads without a shell. `node scripts/stranger.mjs <name> --readme-line --registry` runs each README's line as written once the packages are on npm under the `beta` tag.
