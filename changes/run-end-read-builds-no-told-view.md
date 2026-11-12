---
packages: @parcha/agentrun-serve
kind: fix
---
A server no longer rebuilds the view of each of its 50 newest runs four times a second while it follows run ends for the outbound webhook. Each build redacted the run's title and output again, and read the store, even for a run whose end it had already told, or that had not ended. Now only a run with an end still to tell reads its view, once, and the rest are read from their store row alone. An idle server that had redacted a finished run's view 48 times a second now does nothing for it.
