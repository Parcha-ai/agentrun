---
packages: @parcha/pi-vision
kind: fix
---
The `report` skill's "Not checked" lists only what no look of the run covered: a page, a window of a film, a file the run did not look at. Each item is `{ file, pages or t: [from, to], why }` with `why` one of "not looked at", "out of budget" and "could not be read", so it never states a finding, a presence or an absence ("pages 2 and 4 do not contain the marks"), which need their look and cite. The check refuses an item that a look of the run covers (a page it looked at, a window a cited moment falls in, a file it looked at) and an item that is not in that shape, and the section is left out when the list is empty. `look()` and the new `cover()` record what the run looked at.
