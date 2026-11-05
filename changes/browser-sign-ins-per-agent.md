---
packages: @parcha/agentrun-serve
kind: feature
---
An agent's browser stays signed in: sign in once in one of its runs, and every later run of that agent starts from that signed-in browser. Sign-ins are kept per agent, never shared between agents.
- The cookies stay at the browser's vendor, in a Browserbase context or a Kernel profile (`agentrun-<home key>-default`). The server keeps one pointer per agent and vendor, sealed under `AGENTRUN_SEAL_KEY` and bound to its agent, in the agent's home under `sign-ins/`, a host-owned folder the home API neither reads nor writes (`capabilities.home.host_owned` lists it). With no seal key nothing is kept. A local Chrome keeps none.
- The server makes the agent's Browserbase context when it has none (it opens no session) and hands a run the pointer over its pipe, never in its environment; the run's process never gets the seal key, and the model never sees the pointer.
- The first run of an agent to start with the browser holds the save lease, and its sessions save. A run of the same agent started meanwhile starts signed in and saves nothing. The lease ends when its run's process goes or the run ends.
- `GET /v2/agents/{id}` lists `sign_ins` (`key`, `provider`, `state` ready or held, `held_by`, `verified_at`), never the pointer; `capabilities.features.sign_ins` is true with a seal key and a browser vendor. `DELETE /v2/agents/{id}/sign-ins/{key}` (this server's own route) deletes the vendor's context or profile, best effort, and the pointer; it is `409 sign_in_held` while a run holds the lease.
