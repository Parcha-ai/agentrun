---
packages: @parcha/agentrun-serve
kind: fix
---
`template eval`: the read of a run's timeline page now stops at the run's deadline and at the eval's stop (Ctrl-C), as the read that asks whether a runner holds it does. A page that stalls is given up on after 15 s and asked again. Before, a server that stalled a page held the eval until fetch's own 300 s timeout, past the deadline, and the run then ended "unknown", not cancelled as timed out. A read that the deadline ends now ends the wait at once, with no further page read. A deadline that has already passed sends no read, and a cancel at the deadline that fails still ends the run timed out. `evalTemplate` refuses a `runTimeoutMs` or `queueTimeoutMs` that isn't a number of milliseconds over 0 (NaN, 0, below 0, Infinity) with a RangeError, before anything runs. Before, NaN left the wait with no deadline, and a fraction of a millisecond threw from the claim read.
