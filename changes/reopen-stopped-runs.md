---
packages: @parcha/agentrun-serve
kind: breaking
---
A person's stop ends the turn, not the run, and a message goes on from any run the person may still talk to:

- **Breaking for a SQLite data directory.** The store's SQLite schema is now version 7 (a run's outcome tells a person's stop from a cancel). A server or runner of this release refuses a data directory an earlier release set up, with `SchemaVersionUnknown`: start this release on a new, empty data directory and add your agents, MCP servers, keys and sign-ins there again, or keep the old directory with the earlier release. A Postgres store migrates itself (migration 0004).
- **A stopped run reads `input_required` and `idle`.** A run a person stopped reads waiting on their next message, with nothing pending, not `cancelled`. A message runs as its next turn, and the run ends on that turn's answer. A cancel still ends the run for good (`cancelled`, 409 to a message).
- **A message to a completed agentic run is a follow-up turn.** The console offers a follow-up on a completed run, and the server now takes it (202, mode `follow_up`) instead of answering 409. A failed run, a cancelled run, a workflow run and an imported run still answer 409 in their own words.
- **A message sent while a run is finishing runs after its end.** A message that arrives after the run's answer, while it writes its end, opens the completed run again with that message as its next turn, never lost and never answered by the end-of-run step.
- **A stop while an approval waits and a later turn runs** withdraws the call and cuts the turn; the run reads `input_required` and idle, and a later answer is 409.
- **An OpenCode MCP tool is held to its own setting.** The runner's tool gate now knows the run's MCP servers, so an agent's `mcp:<server>/<tool>` setting applies to OpenCode's own name for that tool (`<server>_<tool>`), where before the call fell back to ask.
