---
packages: repo
kind: feature
---
**`apps/viewer`: embed mode**
- `&embed=1` frames the viewer in another page: no header (a recording that breaks the format still says so) and the
  full width of its frame.
- Framed, it speaks a `postMessage` protocol (`PANELS.md`, "Embedding"). It posts `ready` (its stops and chapters),
  `position` at each stop (stop, gen, commit, t and chapter) and `focus`. It obeys `seek` (a stop, a commit of a
  generation, or a time), `focus` (a workflow path) and `theme` (light, dark or auto), each field checked, and only from
  the framing page at the origin its URL names with `&parent=<origin>`; without it, the viewer listens to nothing.
