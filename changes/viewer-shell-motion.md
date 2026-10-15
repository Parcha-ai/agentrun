---
packages: repo
kind: feature
---
The viewer's panel contract can draw motion by time: a node's `vars` set CSS custom properties (numbers only), `ViewContext.now` is the playback clock, an `animated` panel is redrawn about ten times a second while playing, and a `featured(lines)` panel is shown first with the playback controls under it (the first registered one wins). `?t=<seconds>` opens the viewer at a time. Panels that set none of these draw exactly as before; see `apps/viewer/PANELS.md`.
