---
packages: @parcha/agentrun
kind: fix
---
`npx @parcha/agentrun` with `AGENTRUN_PUBLIC_URL`, on a server whose owner has no password yet, now shows the server's "Set up this server: <public URL>/setup#code=…" line on stderr. Setup at a public address asks for that code, and the command hid the line, so a fresh server behind HTTPS couldn't be set up from its own address.
