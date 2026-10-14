---
packages: @parcha/pi-transport
kind: fix
---
A workspace or file copy no longer reports a stall while a side is still starting. The stall limit ("no byte moved")
was running during each side's setup (the parts directory, the program's start), so a box that took longer than the
limit to answer one call cut a healthy copy with `timeout` after 0 bytes; the hold is now taken before the first call
and kept until the side is up. The default limit is 60 s, so only a smaller `stallMs` on a slow box was exposed.
