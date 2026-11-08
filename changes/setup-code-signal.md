---
packages: @parcha/agentrun-serve
kind: fix
---
Setup at a public address asks for the setup code when the console is opened at its plain address: `GET /v2/auth/session` says, before a password is set, whether setup takes the code the server printed (`setup_code: true` at a public address, `false` on an open setup, never the code itself), and the console's setup form shows its Setup code field whenever it does, with where to find the code ("Find the setup code in the server's log (on Render, the Logs tab), or open the link the log prints."). Before, the field showed only when the link carried the code, so a first visit at the plain address failed with "That setup code is not the one in the server's log".
