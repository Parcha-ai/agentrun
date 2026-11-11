---
packages: @parcha/agentrun-serve
kind: fix
---
A bare loopback address with its port at the end of a sentence (`localhost:9000.`, `127.0.0.1:9000.`, `[::1]:9000.`) is now served as "a local address." in a run's words and its Timeline, as it is mid-sentence. Its path goes with it (`localhost:9000/v1/responses.` reads "a local address."), where only the host and port went before.
