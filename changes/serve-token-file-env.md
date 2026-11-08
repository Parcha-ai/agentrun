---
packages: @parcha/agentrun-serve
kind: fix
---
Started with `AGENTRUN_TOKEN`, the server removes a `DIR/.token` left by an earlier start. That file held a token the server no longer takes, so anyone told to read the token there got a 401. A later start without `AGENTRUN_TOKEN` makes a new token and file.
