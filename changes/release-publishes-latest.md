---
packages: repo
kind: ci
---
The release workflow publishes each package with npm's `latest` dist-tag and then tags the same version `beta`, so npm's package pages show the README. npm takes a package page's README from the publish that carries `latest`; publishing with `--tag beta` and moving `latest` later with `npm dist-tag add` left every `@parcha` page without one. A release now moves `latest` when it publishes. The workflow installs npm 11.21.0, the first that can move a dist-tag with the trusted publisher's OIDC token, and each package's trusted publisher must allow npm dist-tag.
