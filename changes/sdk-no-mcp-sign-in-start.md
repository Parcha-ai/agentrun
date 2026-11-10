---
packages: @parcha/agentrun-client
kind: fix
---
The TypeScript and Python clients no longer offer methods for routes only a browser or GitHub calls (#2140). An MCP server's OAuth sign-in start (`startMcpOauth`) had come back by accident and could never finish a sign-in: its callback requires a cookie that the start's answer sets on whoever sent it, so a sign-in starts in the owner's browser, on the console's MCP page. Connect GitHub's start and the two pages GitHub sends the browser back to are bound to that browser's cookie the same way, and GitHub's own webhook delivery takes no token.
- The server's OpenAPI document marks the browser routes `x-agentrun-browser-only`, with why; the generated CLI and clients give such a route no command and no method, and keep it in the clients' operation tables, so a raw call's body bound for a secret one is still cut.
- `receiveHook_github` is left out of the CLI and the clients, as the generic webhook route already was.
