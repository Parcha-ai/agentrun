---
packages: repo
kind: ci
---
Tests only: the CLI test that starts a server with accounts off and a public URL lets the server pick its own port (`--port 0`) and reads it from the start line, so another process can no longer take the port between the test choosing it and the server listening.
