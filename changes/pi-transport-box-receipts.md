---
packages: @parcha/pi-transport
kind: feature
---
`boxReceipts({ prices, write })`: a ledger of the boxes its wrapped providers make, with one receipt per box when it
ends (destroyed, found ended, or gone): `{ box, provider, kind, from, to, seconds, usd_per_second, cost_usd, source,
priced }`, for the host to write as a live `transport` line of kind `box.receipt`. `box` is a label, never the
provider's id: a host's `label(made)` is called when the box is made, with its own request and facts, and `taken`
carries the labels a recording holds across a restart. The prices are the host's, and a box with no price writes no
receipt. A box found ended after it expired is counted up to its maximum lifetime, not to when it was found.
`cost_usd` is an estimate at list price, not the provider's invoice. `labelOf(provider, id)` says the label a
box was given, and wrapping a provider the ledger already wraps returns it. It comes from the package root;
`./box/receipts` is not an entry.
