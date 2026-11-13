---
packages: repo
kind: breaking
---
The Mac demo tasks check Computerd's calendar data grant next to the five Automation grants. Without it, Calendar's AppleScript got no answer on CI's runner, so `seed-tcc.sh` seeds it there. Computerd's Info.plist now says why it asks for Automation and calendars. The snapshot asks Calendar and Notes separately and names the one that does not answer. An `exec.run` that times out says so. A task's Finder windows close by their sandbox name as well as their path, and the sandbox root goes with the `.DS_Store` Finder leaves in it. CI prints the TCC requests made during the demos, counted by service. Breaking: `mini-demos.py --ask-grants` raises a sixth prompt (calendars), and a run stops until it is granted.
