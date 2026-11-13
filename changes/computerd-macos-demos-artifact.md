---
packages: repo
kind: fix
---
The macOS job's logs artifact also holds the demo tasks' folder (`/tmp/computerd-ci/demos/`: each task's cropped frames, timeline, observations and movie) and is kept 7 days. The demos' `--movie` frames are no longer all black: the cut painted the Dock's full-display window, which is in front of every app, so it now skips that one window.
