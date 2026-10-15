---
packages: repo
kind: fix
---
The viewer's transport panel no longer reads a host kill line with no `kind` as a whole-box kill: a kill's kind is `process` or `box`, an absent kind means a process, and only `box` is a box (the strip counts follow). A process that comes back with no box named no longer prints "at box ?". A recording with no transport lines now draws nothing from this panel, so a reference run's plain process kills no longer open an empty "Boxes" heading and a kills strip.
