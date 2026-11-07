---
packages: @parcha/pi-durable-disk
kind: ci
---
A test pins how often a run's journal commits and how many of those commits sync the disk: one scripted 24-turn run counts every commit and the `synchronous` level it ran at, and checks the count against the commit frames the run's write-ahead log holds. Today every commit is FULL: 18 per turn (two model requests, one side-effecting and one replay-safe tool call), 4 at open and 1 at each end.
