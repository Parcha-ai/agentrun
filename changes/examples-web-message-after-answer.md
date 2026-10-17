---
packages: repo
kind: fix
---
examples/web: a message that comes after a run answered, between its instance's exit and its carry back, waits for the carry back and gets `409 RUN_FINISHED`. Before, it started the run again, and once the carry back landed that instance was never stopped, so it stayed up with its browser. An instance still up for a run that is already carried back (by another writer of the home) is now sent SIGTERM.
