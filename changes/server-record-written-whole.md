---
packages: @parcha/agentrun-serve
kind: fix
---
The server's record (`.server.json` in its data directory) is written under a name of its own and renamed into place, so a reader that finds it (`npx @parcha/agentrun` reads it to find a running server) reads all of it, never an empty file the server has made but not filled yet.
