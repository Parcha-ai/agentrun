---
packages: repo
kind: ci
---
The pi-transport test that checks a checkpoint counts its held time from when the session came to rest, not from the pull's ask, no longer fails on a loaded runner: it compares the held time with the measured total (held is at most the total minus the 400 ms drain) instead of an absolute 300 ms bound.
