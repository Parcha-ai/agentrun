---
packages: @parcha/agentrun-computer
kind: fix
---
The E2B provider talks HTTP/1.1 to E2B on every call. When an idle HTTP/2 session in the E2B SDK's client timed out, its error landed where nothing listened for it, and that could end the whole server and every run in it.
