---
packages: @parcha/pi-transport
kind: feature
---
`./place`: `boxPlace(options)`, a session's place in a box for a supervisor that starts, kills and restarts it. It
starts pi-transport's runner in the box (`boxRunner`), kills a runner by its process (`killRunner`, KILL first) or by
its box, restarts it in the same box or, for a lost box, in a new one from the newest checkpoint (`recoverHome`),
takes checkpoints at rest (`pullCheckpoint`), reads a runner's kill request and the transport's crossings
(`signals`), ships every runner's commits into the vault's log (`recordSink`, the host's `recorder` takes the lines)
and asks one model server for all of them, reports the run's status, carries the files an order names back from the box (`carry`), and brings a
recording written in the box home when its supervisor asks (`recordHome`, `clockSkewMs`).
The app contract gains `AppContext.env` (the session's environment, from `ResumeOrder.env`, over the link), `root` and
`epoch`, and `onResumed`, called once the session has resumed and not awaited by the order; `recoverHome` takes `env`,
`boxRunner` takes `onProcess`, and a home refuses an order whose `env` is not names to strings (`invalid`).
