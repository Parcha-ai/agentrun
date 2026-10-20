---
packages: repo
kind: fix
---
The gallery's list now follows the lock's order. `build()` lists the recordings in the order of the lock's ids when it is given a lock (the ids the lock does not name come after, by name), the gate checks that the built index lists them in that order, and the lock's ids are in the order the gallery should show: the three earlier recordings as they stand today, then the three utility-account replays as a story told in parts. A lock entry's `title` also refuses the C1 control characters (U+0080 to U+009F), as it already refused the C0 ones and DEL. The recordings and the asset are untouched; the tar, written with its members sorted by path and read by id, does not depend on the lock's order.
