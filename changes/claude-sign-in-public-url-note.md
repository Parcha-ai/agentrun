---
packages: @parcha/agentrun-serve
kind: fix
---
Settings → Model keys, Claude Code's login on this machine: a server that never starts the CLI's sign-in itself now says why, instead of falling back to the terminal command in silence. `GET /v2/settings/claude-login` answers `start_off` there, naming the public address and the variable it came from (`AGENTRUN_PUBLIC_URL`, a placeholder one too, or Render's `RENDER_EXTERNAL_URL`) or the address past loopback the server listens on, and what to do: run the command shown in a terminal on that machine, or unset `AGENTRUN_PUBLIC_URL` (or listen on 127.0.0.1) and restart. The console shows it beside the command, and `POST /v2/settings/claude-login/login` refuses there in the same words.
