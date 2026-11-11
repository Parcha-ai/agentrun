---
packages: @parcha/agentrun-serve
kind: fix
---
The agent's browser hand-over request (`browser_request_handoff`) is no longer written as a file in the run's workspace. Its only record is its waiting entry in the run's journal, so `GET /v2/runs/{id}/files` no longer lists it, and the agent's file tools (read, write, edit, bash) cannot read, change or plant one. The live view's Hand back and a run taken up again after a restart read pending requests from the journal, so a file the agent writes changes nothing the person sees or what Hand back answers.
