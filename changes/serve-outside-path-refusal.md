---
packages: @parcha/pi-durable-disk, @parcha/agentrun-serve
kind: fix
---
A refused read, write or edit of a path outside the workspace no longer names a host path. pi's file tools resolve a path against the workspace before the confinement checks it, so the refusal named the resolved path (`../../.token` read as `<data>/runs/.token`), the workspace's own directory, and, through a link, where the link points. `PathOutsideWorkError`'s message now names no path (`outside the workspace`), and `refusalOf(error)` tells a refusal from any other error by its type. agentrun serve names the refusal by the path the call gave, as it gave it (`../../.token: outside the workspace`), on pi and on the other harnesses alike, so neither the model nor the run's timeline reads the server's data directory.
