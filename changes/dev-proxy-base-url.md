---
packages: repo
kind: fix
---
The console's dev server (`npm run dev` in `apps/console`) names the server it proxies to with `AGENTRUN_BASE_URL`, the name AgentRun's clients and CLI read, with or without `/v2`: the two lines a server prints when it starts now work as they are. It read `AGENTRUN_URL`, a name of its own.

- Its key follows the client's rule. `AGENTRUN_API_KEY` goes to the server that is named. `AGENTRUN_TOKEN`, a local server's token, goes only to a server on this machine (`localhost`, `127.0.0.1`, `[::1]`); before, it went to whatever address was named. When a token is set and not sent, the dev server says so once, naming the server and never the token.
- For contributors: a shell that still sets `AGENTRUN_URL` and no `AGENTRUN_BASE_URL` is refused when the dev server starts, by name, so it never proxies to the default local server unnoticed. Set `AGENTRUN_BASE_URL`, and `AGENTRUN_API_KEY` where the server is not on this machine. A build and a test run read none of these variables.
