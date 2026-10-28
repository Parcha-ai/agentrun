---
packages: repo
kind: ci
---
**The ten-kill test covers every class of crossing with planted kills, not the seeds' draws**
- A seeded kill lands at the nth crossing a process takes, and the order of those crossings shifts with timing. The seeds therefore did not always reach every class: a CI run missed `judge`.
- `killAnywhere` now takes `planted` kills, each planned by point name on either side. A new test plants one kill at a point of each class, in the run's order, and asserts that each one lands there and that every class is covered.
- The seeded runs keep every other check, and the draws are extras.
