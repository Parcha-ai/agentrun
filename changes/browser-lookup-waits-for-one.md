---
packages: @parcha/agentrun-computer
kind: fix
---
A Browserbase or Kernel create that finds two or more running browsers of its request lists them again every 2 s, for up to the provider's `cleanupMs` (30 s by default), until one is left, and answers that one. Before, it answered the oldest at once. While another create's recovery from a lost reply still read the request, that oldest could be the lost create's browser, which the recovery then released: the create that answered it held a browser that had ended. A read that fails, or the bound reached, answers the oldest as before; a caller's abort while it waits is refused `aborted`.

The computer README says which read again of a lost create's request decides (the last one), and the doc of `convergeSettled` says it reads `unread` when mine is not listed or no newer one is.
