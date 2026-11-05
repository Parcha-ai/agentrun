---
packages: @parcha/agentrun
kind: fix
---
`npx @parcha/agentrun` now tells the person at the terminal how to stop it and where its data is kept: "Press Ctrl-C to stop it. Its data is in ~/.agentrun." (or the directory `--data` names), on stderr, so the one line on stdout that scripts read is unchanged. The command also reads `--data=<dir>` as it reads `--data <dir>`, and the last one given wins, as on the server, which is handed exactly one: before, `--data=<dir>` sent the server two and the command named the wrong one. It also says where the API's bearer token is (`<data>/.token`, or the `AGENTRUN_TOKEN` it was started with): the server's own line saying so stays out of this terminal.
