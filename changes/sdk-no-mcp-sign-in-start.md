---
packages: @parcha/agentrun-client, @parcha/agentrun
kind: breaking
---
The TypeScript and Python clients and the CLI no longer offer routes only a browser or GitHub calls (#2140). Who breaks: a caller of the clients' `local.startMcpOauth`, `local.connectGitHub`, `local.gitHubCallback`, `local.gitHubInstalled` or `local.receiveHookGithub` (Python: `start_mcp_oauth`, `connect_git_hub`, `git_hub_callback`, `git_hub_installed`, `receive_hook_github`), or of the CLI's `agentrun local git-hub-callback`, `local git-hub-installed` and `local receive-hook-github`. What to do: start an MCP server's sign-in and Connect GitHub on the console; none of these could finish from a client. An MCP sign-in's callback requires a cookie that the start's answer sets on whoever sent it; Connect GitHub's start and the two pages GitHub sends the browser back to are bound to that browser's cookie the same way; GitHub's own webhook delivery takes no token.
- The server's OpenAPI document marks the browser routes `x-agentrun-browser-only`, with why; the generated CLI and clients give such a route no command and no method, and keep it in the clients' operation tables, so a raw call's body bound for a secret one is still cut.
- `receiveHook_github` is left out of the CLI and the clients, as the generic webhook route already was.
