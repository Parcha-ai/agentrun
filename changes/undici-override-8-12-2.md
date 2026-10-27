---
packages: repo
kind: fix
---
**This repository's install resolves undici 8.12.2 under the disk SDK and pi-coding-agent**
- Both pin undici 8.10.2 exactly. Root `overrides`, scoped to those two packages, move their copies to 8.12.2. pi-browser keeps its own undici 6, which a blanket override would also have moved. CI now checks that no undici in the install is below 8.12.2.
- Overrides apply only in the project that runs the install, so a project that installs these packages gets 8.10.2 under them until those releases move their pins. To install 8.12.2 there, add the same overrides to your own `package.json`: `"overrides": { "disk": { "undici": "8.12.2" }, "@earendil-works/pi-coding-agent": { "undici": "8.12.2" } }`.
