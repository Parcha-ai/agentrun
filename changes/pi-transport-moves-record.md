---
packages: @parcha/pi-transport
kind: feature
---
A move's durable record: the target writes the document `transport.moves`, keyed by the move id, once, in the first
commit it makes when it opens the moved store (`MoveRecord`, `MovesDoc`), from what the host sends in
`ResumeOrder.move.record` (`MoveFacts`). `moveHome` sends the places, its drain, ship and take times, its bytes and
its seal; its `head` is the seal's. A home `Place` takes a `label`, the name a recording gives its box
(`whereOf(place)`), and the box place passes its boxes' labels. An order with no record writes none.
