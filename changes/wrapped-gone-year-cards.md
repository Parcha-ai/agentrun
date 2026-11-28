---
packages: @parcha/agentrun-serve
kind: fix
---
Wrapped draws the cache card and offers the leak receipt for a year whose session files are gone. Both come from what the store keeps of the year's imported runs (`GET /v2/wrapped`'s `cache` and `secrets`), not from the files on disk, so a year with no session files left now shows them under its empty notice. The receipt stays off until the person turns it on. A year the store keeps nothing for still shows no cards.
