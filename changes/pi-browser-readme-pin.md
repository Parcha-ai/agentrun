---
packages: @parcha/pi-browser
kind: docs
---
`@parcha/pi-browser`: the README's Install block has a line for a pi-durable host that pins `@earendil-works/pi-durable`, `chord` and `pi-ai` to 1.3.0, and says pi 1.4 is not supported yet. pi 1.4.0 is npm's latest and the peer range stops below it, so the same names unpinned stop `npm install` with ERESOLVE. The first screen's pi range reads 1.1 to 1.3, the range of the peers.
