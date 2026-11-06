---
packages: @parcha/agentrun-serve
kind: fix
---
A server on 127.0.0.1 answers `localhost`, `127.0.0.1` and `[::1]` on any port, so `ssh -L 8080:localhost:7340`, a proxy in front, or a start that took the next free port reach it. Before, the `Host` had to carry the server's own port, and anything else got `403 unexpected Host header`. The `AGENTRUN_PUBLIC_URL` name and each `--allow-host` name are served the same way, with or without a port, so an HTTPS proxy on the same machine that passes its own `Host` (Caddy's default) works. Every other name is still refused (the guard against DNS rebinding). A browser now gets a page that says which names work and how to add one; a script gets the same in the error's message.
