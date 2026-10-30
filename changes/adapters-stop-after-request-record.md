---
packages: @parcha/agentrun-kernel
kind: fix
---
A stop that comes while a paid request's record is being written now keeps the request from leaving. The runner checked for a stop only before that write. It now checks again once the record is in. A request stopped there is booked as withdrawn, a `runner.turn` with `usd: 0` and `unsent: true`, so a later process never books it as cut at an unknown price, and the session's spend stays known.
