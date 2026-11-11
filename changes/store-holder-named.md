---
packages: @parcha/agentrun-serve
kind: fix
---
A store transaction that runs out of time, or a write that waits out the store's busy timeout, now logs who held the store: where the transaction was opened, how late its deadline fired when the server's event loop was held, and the other transactions open in the process. A request answered `409 home_busy` logs it too, where before it logged nothing.
