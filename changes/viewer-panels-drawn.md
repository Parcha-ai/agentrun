---
packages: repo
kind: feature
---
**`apps/viewer`: a panel with nothing in a recording is not drawn**
- A panel is drawn only for a recording that holds a line it is for: one its new optional `shows(line)` says yes to,
  or, without `shows`, one it `accepts`. With none, the shell draws nothing for it, not even its title. The shell
  judges this once over the whole recording, never up to the stop, so no panel appears or vanishes mid-scrub.
- The transport panel declares `shows` for `transport` lines: it reduces the counters' lines for its own counters, so
  until now it drew an empty titled box on every run without transport lines.
