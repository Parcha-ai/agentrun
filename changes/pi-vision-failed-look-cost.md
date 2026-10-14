---
packages: @parcha/pi-vision
kind: fix
---
A failed look's record says what it cost, so one miss no longer makes a run's cost unknown. A miss filed before any request to a model (no eyes, eyes that take no images or no video, an image over a limit, every miss of `read`) has `cost_usd: 0`, `tokens_in: 0` and `tokens_out: 0`. Eyes that answered with no text file that answer's tokens and price, and a recording whose source answered with no text files that answer's price and `provider` (`kept: true` when it was read back). A request to the eyes, or a recording's source, that threw may have been billed: its record has no `cost_usd`.
