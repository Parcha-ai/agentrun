---
packages: repo, @parcha/agentrun, @parcha/agentrun-serve
kind: docs
---
Every way to run AgentRun (`npx`, Render, Docker, Compose) starts with no model key and ends the same way: Continue with ChatGPT (Settings → Model keys, or the first screen), then run your first agent. A model key stays the other way, beside it.
- The deployment guide has one copy-paste `docker run` line: the server and a runner on a named volume, a seal key made once in a file beside it, the port on this machine's loopback, no model key.
- Where Render and Docker are introduced, the docs say that a ChatGPT sign-in is for the person who runs the server, with OpenAI's words on usage, and how to finish it on a server elsewhere: copy the sign-in tab's whole address into the console.
- The harness table says which harnesses run on a ChatGPT plan (pi and Codex); Claude Code, OpenCode, Jev decisions and paid tools need their own keys. The server's README documents `/v2/settings/chatgpt` and `models.source: "chatgpt"`.
- The setup skill offers "Continue with ChatGPT" or a model key, and leaves the sign-in to the person.
