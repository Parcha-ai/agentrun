---
packages: @parcha/pi-vision
kind: fix
---
A failed look's record says what it cost, so one miss no longer makes a run's cost unknown. A miss filed before any request to a model (no eyes, eyes that take no images or no video, an image over a limit, every miss of `read`) has `cost_usd: 0`, `tokens_in: 0` and `tokens_out: 0`. Eyes that answered with no text file that answer's tokens and price (`kept: true` when it was read back). A request to the eyes that threw, and a recording whose source threw or answered nothing, may have been billed: their records have no `cost_usd`.
