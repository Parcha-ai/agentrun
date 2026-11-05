---
packages: repo
kind: docs
---
The dependency inventory (docs/dependencies.md) and the release notices read OpenCode's twelve platform binaries (opencode-darwin-arm64@1.19.5 to opencode-windows-x64-baseline@1.19.5) as MIT, from OpenCode's own LICENSE at the pinned release, instead of "UNKNOWN — Missing license metadata": their package manifests name no license. The reading is pinned by name and version, so a bumped binary is flagged again until it is checked. The release review's flags drop from 21 to 9.
