---
packages: repo
kind: ci
---
The release workflow publishes each package with npm's `latest` dist-tag, so npm's package pages show the README. npm takes a package page's README from the publish that carries `latest`; publishing with `--tag beta` and moving `latest` later with `npm dist-tag add` left every `@parcha` page without one. A release now moves `latest` when it publishes, and a maintainer moves `beta` to the same version afterwards.
