---
packages: @parcha/pi-vision
kind: docs
---
The README's install lines for the pi packages name `@1.3.0` (`@earendil-works/pi-ai`, `pi-codemode`, and the adapter's peers `pi-durable` and `chord`), and say pi 1.4 is not supported yet: the peers stop below 1.4.0, so an unpinned `npm install @earendil-works/pi-durable @earendil-works/chord` now ends in ERESOLVE. `pi install npm:@parcha/pi-vision@beta` works with pi 1.3 and 1.4.
