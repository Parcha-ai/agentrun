---
packages: repo
kind: ci
---
The install and npx walks share one first run (packages/agentrun/test/first-run.sh). Every walk takes the image to walk as `AGENTRUN_IMAGE`, and one action (.github/actions/walk-image) loads it.
