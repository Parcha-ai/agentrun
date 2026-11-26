---
packages: @parcha/agentrun-import
kind: fix
---
A record whose `timestamp` is a number past what a Date holds (more than 8.64e15 ms either side of the epoch) no longer ends its file's read with `RangeError: Invalid time value`: it has no time, as a timestamp that is no number or string has none, and the file's other records keep theirs.
