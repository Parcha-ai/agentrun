---
packages: repo
kind: feature
---
The reference entry has a place seam: `demo({ place })` takes a `Place` (where the session lives and how its process starts, stops and restarts), and `localPlace` is the child process of this machine. The supervisor decides when to kill and writes the kill line first; the place decides how. A place whose runner opens a claim is handed a fresh mount token on the runner's standard input for each attempt, never in argv or env, and a place that cannot lose its machine refuses a box kill.
