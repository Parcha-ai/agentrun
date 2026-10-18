---
packages: @parcha/agentrun-reference
kind: feature
---
A recorded demo on a real browser (Browserbase, or a local Chrome with `--local-chrome`) keeps what the browser showed: pi-browser's frame recorder screencasts each session into the recording's `frame` and `frame.gap` live lines, each JPEG a blob, and when the process detaches its recorder a `frame.track` per session (a WebM and its index) is made from them with ffmpeg. At most 4 frames a second per session, and only when the page changes; a still page costs nothing. The fake browser is not recorded, and a demo with `browser: false` has no browser. With no ffmpeg the frames stay and no track is made, with an `AGENTRUN_FRAME_TRACK` warning.
