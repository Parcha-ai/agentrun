---
packages: @parcha/pi-durable-disk
kind: fix
---
**A claim directory's descriptor is closed by `close()` only, never by garbage collection (GRE-3853)**
- While a new run's seed waited on a promise nothing else held, the open's pending await chain was all that reached the
  claim directory, so a collection could close its FileHandle. The start mark's keeper, which writes through
  `/proc/self/fd/<n>` on a thread of its own, then failed silently, and the supervisor's grace ran out under a live seed.
  A later open in the process could also be handed that number, and the keeper would have written the mark there.
- Every handle the package hands out as `/proc/self/fd/<n>` (the claim directory's `at`, a confined pin's paths, the walk
  that makes them, the text line reader and the temp directory) is now held until it is closed.
- The keeper writes only while its directory is still the one it started on (same device and inode). If the directory
  can't be reached or is another one, it stops. Its first failure is a process warning, code `PDA_START_MARK`, not
  silence.
