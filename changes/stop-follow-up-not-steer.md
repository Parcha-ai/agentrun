---
packages: @parcha/pi-durable-agent, @parcha/agentrun-serve
kind: fix
---
A message sent after a stop reads as the person's next message in the timeline ("You: …"), never as a steer ("You (steer): …"). The timeline took any message right after a tool round as a steer into the running turn, but a stop or a cancel can cut a turn right there. The timeline now reads two marks a cut leaves:
- an aborted call's result (pi-durable's `aborted` diagnostic);
- the end mark of a model request that had left and was aborted (`agentrun.request_ended`, neither `unsent` nor a compaction's).

After either of these, the next message starts a new turn, in the stored view and the live one alike. A message placed between a tool round and the next request is still a steer.

agentrun-serve's README, `llms.txt`, the serve skill and the MCP tools `runs_respond` and `runs_cancel` now say what can be continued. A stopped run can: a follow-up starts a fresh turn on its history, and the cut turn is not replayed. A cancelled run cannot: a message to it is `409 not_continuable`, so start a new run.
