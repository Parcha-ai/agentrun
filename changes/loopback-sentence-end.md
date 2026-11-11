---
packages: @parcha/agentrun-serve
kind: fix
---
A loopback address in a run's words and its Timeline is rewritten as "a local address" and nothing more around it is taken: a bare one with its port at the end of a sentence (`localhost:9000.`, `127.0.0.1:9000.`, `[::1]:9000.`) is rewritten as one mid-sentence is, a bare one's path goes with it (only the host and port went before), and a full stop after one with a scheme stays (it was taken with the address). An address's path also ends at a backslash, so one quoted inside a JSON string leaves the JSON whole.
