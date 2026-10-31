---
packages: repo
kind: fix
---
The console's `npm run dev` proxies `/v2` to an AgentRun Server on this machine at serve's default port when `AGENTRUN_URL` is not set, as it did before; `AGENTRUN_URL` still names any other server, and `AGENTRUN_TOKEN` still goes as a bearer header from the dev server only.
