---
packages: @parcha/pi-browser
kind: feature
---
`@parcha/pi-browser/recorder`: `frameRecorder` screencasts each browser session over DevTools (a local Chrome, Browserbase and Kernel all speak it) and hands `agentrun.recording/1` `frame` and `frame.gap` lines, with their JPEGs, to a sink you pass. It is read-only beside the session's own connections and writes nothing itself. Capture is JPEG at quality 60, at most 800 px wide and 10 frames a second per session. A gap is written, never filled (`process_killed`, `session_released`, `credential_on_page`). No frame is kept while a credential or a one-time code is on the page, and a live-view URL is never recorded.
