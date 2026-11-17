---
packages: @parcha/agentrun-serve, @parcha/pi-browser
kind: feature
---
An agent whose computer is a browser can record its runs: `computer: {"kind": "browser", ..., "record": true}` makes a video of each browser session's page, `recordings/<computer>.mp4` with one file per session, under the same caps, pause and stop rules as a desktop's or a phone's, listed in the run read's `recordings` and served by the files route. A browser with `record: true` was refused with 422 before.
  - The video is the live view's own CDP screencast of the session, shared with a person's viewer (one screencast per session, never a second); each frame is stamped as it comes, so a page that sits still does not shorten the video.
  - `@parcha/pi-browser`'s live view takes a host's watch of a session's frames, with or without a viewer: `liveView.watch(tag, { frame, ended })`. A viewer that joins a stream already running is sent the page, any dialog and the newest frame.
