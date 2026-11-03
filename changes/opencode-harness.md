---
packages: @parcha/agentrun-serve
kind: feature
---
AgentRun Server runs OpenCode as a harness: a revision with `harness: "opencode"` runs on the pinned `opencode serve` (`opencode-ai` 1.19.5, an exact optional peer of the server that the host installs), started for each drive of the run's session, with the host's tools as its only tools and its model behind the session's proxy, durable in the run's own store. Its model goes where codex's does: the gateway at `AGENT_MODEL_BASE_URL`, or OpenAI with `OPENAI_API_KEY`, on the Responses API.
- What a host does differently: install `opencode-ai@1.19.5` beside the server to make `opencode` available in `GET /v2/capabilities`. Without it, capabilities say it is not installed and give the install line.
- OpenCode's own events for the session are mirrored into the run's store and given back to a new OpenCode process (`/sync/replay`) on each drive, so a follow-up, a stop or a crash resumes from the store. A turn a crash cut off gets the kernel's recovery note.
- The console offers OpenCode beside Pi, Claude and Codex when the server lists it.
