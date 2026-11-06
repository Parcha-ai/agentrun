---
packages: @parcha/agentrun
kind: fix
---
`npx @parcha/agentrun` now tells the person at the terminal how to stop it and where its data is kept: "Press Ctrl-C to stop it. Its data is in ~/.agentrun." (or the directory `--data` names), on stderr, so the one line on stdout that scripts read is unchanged. The command also reads `--data=<dir>` as it reads `--data <dir>`, and the last one given wins, as on the server, which is handed exactly one: before, `--data=<dir>` sent the server two and the command named the wrong one. It also says where the API's bearer token is (`<data>/.token`, or the `AGENTRUN_TOKEN` it was started with): the server's own line saying so stays out of this terminal.

Started with `AGENTRUN_PUBLIC_URL` (a server behind HTTPS on its own name), the command now starts: it takes the server's "Open https://<that name>/" line, where before it waited 60 seconds for a 127.0.0.1 one and stopped the server. A server that does not start is shown with its own last lines ("AgentRun did not start. The server's last lines: …"), where before the message pointed at lines this terminal never showed. A stop the command passes on (Ctrl-C, a process manager's SIGTERM) now ends it with 0, so `systemctl stop` no longer logs a failure.
