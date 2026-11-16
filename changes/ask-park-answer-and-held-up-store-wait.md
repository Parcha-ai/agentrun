---
packages: @parcha/agentrun-serve
kind: fix
---
Two fixes for runs that wait on a person and for a server whose process is briefly held up.
- An answer sent just as a run paused on its question could leave the run reading working/idle for good, never resumed. This happened when no hold of the person's time fit the run's cap (so the run parked), or when the run had nothing to hold open, and the answer landed while the park let the browser session go. The answer started a turn that the park then cut, and nothing was left to wake the run. Now the answer waits for the park and resumes the run from it, and one that lands before the park starts is the run's next turn in the same claim.
- With the runner beside the server (the default), a write could fail with "the store stayed locked past its busy wait: database is locked" when the process was held up for about 10 s (a synchronous call, a long pause, a loaded machine) while a transaction of the other side was open. The SQLite store's wait for the write lock now gives back the time the process was held up when the holder is a transaction of the same process, as that transaction's own deadline already does. A wait on another process's write still ends after the busy wait, as before.
