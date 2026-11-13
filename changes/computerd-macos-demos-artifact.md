---
packages: repo
kind: breaking
---
Breaking: `mini-demos.py --movie` refuses outside a demo account. It records only on a CI runner (`GITHUB_ACTIONS=true`) or as a user whose login name starts with `agentrun-demo`; anywhere else it exits 1 before anything is made or recorded, and nothing unlocks it. The demos' `--movie` frames are no longer all black: the cut painted the Dock's full-display window, which is in front of every app, so it now skips that one window. The macOS job's logs artifact also holds the demo tasks' folder (`/tmp/computerd-ci/demos/`: each task's cropped frames, timeline, observations and movie) and is kept 7 days.
