---
packages: @parcha/agentrun-client
kind: fix
---
A wait the client makes (a server's Retry-After before a retry or a stream's reconnect, a poll's interval) now lasts its whole time by the wall clock: a timer that fires a millisecond early, as node's can, is waited out, so a gateway's Retry-After is never cut short.
