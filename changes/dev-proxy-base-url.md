---
packages: repo
kind: fix
---
The console's dev server (`npm run dev` in `apps/console`) names the server it proxies to with `AGENTRUN_BASE_URL`, the name AgentRun's clients and CLI read, with or without `/v2`: the `AGENTRUN_BASE_URL` line a server prints when it starts works as it is. It read `AGENTRUN_URL`, a name of its own.

- Its key. `AGENTRUN_API_KEY` goes to the server `AGENTRUN_BASE_URL` names; with no address it is not sent, so a shell that exports it for the CLI still signs in on the page. `AGENTRUN_TOKEN`, a local server's token, goes only to a server on this machine (`localhost`, `127.0.0.1`, `[::1]`); before, it went to whatever address was named.
- The key rides only on the console page's own requests and a command line's. Before, the dev server added it to every request that reached `/v2`, so another site's page open in the same browser could act with it: a server takes an upload a page can send with no preflight.
- When it starts, the dev server says where it proxies and with which variable's key, or that a key or a token was set and not sent. It names the server and the variable, never the key.
- The dev page says no other site may show it in a frame (`frame-ancestors 'self'`), as the served console says.
- For contributors: a shell that still sets `AGENTRUN_URL` and no `AGENTRUN_BASE_URL` is refused when the dev server starts, by name, so it never proxies to the default local server unnoticed. `AGENTRUN_URL=<address> AGENTRUN_TOKEN=<key>` for a server elsewhere becomes `AGENTRUN_BASE_URL=<address> AGENTRUN_API_KEY=<key>`. A build and a test run read none of these variables.
