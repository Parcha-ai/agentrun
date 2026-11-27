---
packages: @parcha/agentrun-serve
kind: fix
---
A saved key that holds a "+" (a base64 key body, for one) is now withheld when a run prints it split into string literals joined by "+" (`"ab" + "cd+ef"`), double- or single-quoted, also after prose with an apostrophe ("Here's the key:"); before, it showed on the run's view, its Timeline, the event stream, its export and to an eval's grader.
