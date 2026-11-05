---
packages: @parcha/agentrun
kind: fix
---
`npx @parcha/agentrun` now tells the person at the terminal how to stop it and where its data is kept: "Press Ctrl-C to stop it. Its data is in ~/.agentrun." (or the directory `--data` names), on stderr, so the one line on stdout that scripts read is unchanged.
