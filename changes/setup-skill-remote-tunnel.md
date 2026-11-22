---
packages: repo
kind: docs
---
The setup skill (`docs/SKILL.md`, served at agentrun.ai/SKILL.md) now says how to open the console when **This computer** is a remote machine: the person runs `ssh -o ExitOnForwardFailure=yes -L <local>:127.0.0.1:<port> <user>@<host>` on their own computer, with a local port that is free there, and opens the setup link at `http://127.0.0.1:<local>/`, keeping its code. An always-on machine's tailnet or HTTPS address needs no forward. It also rules out every other way: no change to the machine's web server or reverse proxy (Traefik, nginx, Caddy), no new route, DNS name or firewall rule, and no `sudo`. In QA, a setup agent on an SSH box tried to add a route to the machine's shared Traefik config, with `sudo` as its fallback.
