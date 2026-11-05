---
packages: @parcha/agentrun
kind: fix
---
`npx @parcha/agentrun` now tells the person at the terminal how to stop it and where its data is kept: "Press Ctrl-C to stop it. Its data is in ~/.agentrun." (or the directory `--data` names), on stderr, so the one line on stdout that scripts read is unchanged. The command also reads `--data=<dir>` as it reads `--data <dir>`, and the last one given wins, as on the server, which is handed exactly one: before, `--data=<dir>` sent the server two and the command named the wrong one.
