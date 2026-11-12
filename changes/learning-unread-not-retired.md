---
packages: @parcha/agentrun-serve
kind: breaking
---
A learned skill or workflow draft whose front matter can't be read (it reads no way, or its status is none the host writes) still reads `retired`, so no run is given it, but the agent's learning view no longer says a run retired it. Its `retired` is now `{ at, by: "host", why: "unreadable" }`, and the console's card reads "Not read: its front matter can't be read; fix the file to use it" in place of "Retired by a run". Fixes #2444.
Upgrading: a client that reads `retired.by` from `GET /v2/agents/{id}/learning` handles the new value `host` (with `why: "unreadable"`) beside `person` and `run`.
