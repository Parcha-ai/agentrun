---
packages: @parcha/agentrun-serve
kind: fix
---
`agentrun-serve import` cuts the server's own keys (the launcher's secrets, such as `OPENAI_API_KEY`) out of what it keeps. The server's start moves those keys out of its environment, so the import's cut never saw them, and a session that held one kept it in the store. They are now read back in for the cut and replaced with `[redacted]` wherever they appear. A session's id is cut too: one named after its file, when the file's name held a key, no longer keeps it, and a later import still finds the run it made.
