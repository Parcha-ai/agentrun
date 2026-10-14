---
packages: repo
kind: feature
---
`@parcha/pi-durable-disk` installs beside pi-durable 1.1: its peer ranges for `@earendil-works/pi-durable` and `@earendil-works/chord` widen from `~1.0.4` to `>=1.0.4 <1.2.0`, and it is built and tested against 1.1.0. Its store passes pi-durable 1.1.0's storage conformance suite, which now requires scans in either order; the Docker runtime image installs pi 1.1.0. See `packages/pi-durable-disk/CHANGELOG.md`.
