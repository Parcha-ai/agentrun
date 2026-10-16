---
packages: @parcha/pi-browser
kind: fix
---
`@parcha/pi-browser`: a `snapshot` or `browser_read` that lands in a document a navigation replaced waits for the new one and reads once more, instead of failing with Chrome's "Cannot find context with specified id". The held-runtime reset (Stagehand's extension) fails on a target list the browser never gives, instead of reading it as "nothing held", and closes its last wake page before the socket goes, so a runtime still held no longer refuses the next attach. `exportFrameTracks` bounds each blob read by the session's deadline and the abort signal.
