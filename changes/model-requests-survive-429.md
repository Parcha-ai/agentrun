---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel
kind: fix
---
A model request a provider refuses for a while (a 429 at capacity, an overload, a 5xx) no longer ends the run after pi's default three retries of about 17 seconds. The adapter loop gives pi 8 retries, 2s doubling to at most 30s apart (about two and a half minutes), and pi-ai retries a request refused before any output twice more inside each attempt, after the wait the provider asked for: the session's model proxy now passes an error answer's `retry-after`, `retry-after-ms` and `x-should-retry` on to the client. Each retry is a new request the run's cap judges and books: a refused one books nothing, and one that finds no room under the cap parks the run in the cap's words, never retried past it.
