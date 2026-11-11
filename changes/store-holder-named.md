---
packages: @parcha/agentrun-serve
kind: fix
---
A store transaction that runs out of time, or a write that waits out the store's busy timeout, now says in its logged stack who held the store: where the transaction was opened, and the other transactions open in the process with their age.
