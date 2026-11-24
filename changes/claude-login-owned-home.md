---
packages: @parcha/agentrun-serve
kind: fix
---
Claude Code's login on this machine now uses a home the server's own user owns: the server's `HOME` when that user owns it, else that user's own home. A server started under a sudo that keeps `HOME` no longer signs Claude Code in as root inside the person's home, leaving files their own CLI can't read, and a service account that inherited someone's `HOME` no longer reads that person's login as its own. Where the server's user owns neither, Settings says why, the turn-on and the sign-in are refused in those words, and a login saved before is turned off at the start.
