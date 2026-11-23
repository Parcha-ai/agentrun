---
packages: @parcha/agentrun-serve
kind: fix
---
`GET /v2/capabilities` says whether `/v2/settings/claude-login` answers here, as `features.claude_login`: false where those routes are 404 (`AGENTRUN_CLAUDE_CODE_LOGIN=off`, or a server listening past loopback, as in Docker, without `AGENTRUN_CLAUDE_CODE_LOGIN=on`). The console's Settings → Keys reads it first and asks for Claude Code's login only where it answers, so a Docker server's Keys page no longer logs a 404 in the browser at every visit. Against a server older than this field, the console asks as before and shows nothing on a 404.
