---
packages: @parcha/agentrun-import
kind: fix
---
`parseHome` refuses a `workerOldMb` under 8 with a RangeError (`workerOldMb: a whole number of MB, at least 8, not 1`) before any worker starts. Before, it took any whole number from 1: at 1 or 2 MB, V8 ended the whole process as the first worker started ("Fatal JavaScript out of memory: GC during deserialization"), and from 3 to 7 MB the workers ran out of memory (from 3 to 6 before they read a file), so the calling thread read what they lost. Measured on Node 24.22.3: at 8 MB and over, every worker read every file of a synthetic home.
