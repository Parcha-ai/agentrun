---
packages: repo
kind: ci
---
**The stranger test can install with a README's own install line, against the peers the registry serves now**
- A spec names its README's install block (`readmeInstall`), and `node scripts/stranger.mjs <name> --readme-line` installs
  with exactly that line: with `--registry` as written (does the published package install today?), without it with this
  tree's packed package in the line's place (does the next release install?). The peers stay as the line writes them, not
  pinned to the developed versions, so a published range that excludes the registry's latest peer fails here. The line
  is read without a shell, and must install the spec's package.
- `pi-durable-disk` names its quickstart's install line. A new CI job, `stranger-readme-line`, runs both modes and is not
  blocking yet: today both fail with `ERESOLVE` (the published 0.1.0-beta.12 accepts chord and pi-durable `~1.0.4`, main
  `<1.2.0`, and the registry's latest is 1.2.0), and the failure is shown as a warning.
