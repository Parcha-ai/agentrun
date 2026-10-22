---
packages: @parcha/pi-transport
kind: docs
---
The README gives an install line, in "A box": the package with its pi peers pinned at 1.3.0 (`@earendil-works/pi-durable`,
`@earendil-works/pi-ai`, `@earendil-works/chord`). pi 1.4.0 is npm's latest and outside the package's peer range, so an
install that names the peers without a version stops with ERESOLVE; pi 1.4 is not supported yet, and a later release
widens the range.
