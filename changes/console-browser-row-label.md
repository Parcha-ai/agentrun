---
packages: repo
kind: fix
---
A browser step on a run's Timeline is labelled with what its tool does, where it read the tool's wire name ("run", "snapshot"): "Open or act on a page in the browser", "Look at the page structure", "Read the browser's page", and so on, the names the timeline library gives pi-browser's tools and a run's tool counts already show. A browser tool the library names nothing keeps its own name, and every other tool's row is unchanged.
