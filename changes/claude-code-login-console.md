---
packages: @parcha/agentrun-serve
kind: feature
---
The console's Settings → Model keys has the row "Use Claude Code's login on this machine". Off, it asks where the login is (AgentRun's own by default, this machine's `~/.claude` by choice) and for the owner's word that only they run agents on the server. On, it shows the account and plan the CLI reports, or the command that signs the CLI in, plus a button that starts the CLI's own sign-in when the console is on the server's machine. A server that refuses the mode shows its one-line reason, and a server with the mode switched off shows no row. A run on the login reads "On your Claude plan" with no dollars. The Anthropic key's row says which Claude plans include monthly API credits.
