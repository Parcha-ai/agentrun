---
packages: @parcha/pi-durable-disk
kind: docs
---
Every install line in the README and the examples pins `@earendil-works/pi-durable`, `@earendil-works/pi-ai` and `@earendil-works/chord` at 1.3.0. pi 1.4.0 is now npm's `latest`, and an unpinned line ends in ERESOLVE against the peer ranges (`>=1.0.4 <1.4.0`). pi 1.4 is not supported yet; a later release widens the range.
