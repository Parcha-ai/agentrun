---
packages: @parcha/agentrun-serve, @parcha/agentrun-harness-claude, @parcha/agentrun-kernel
kind: feature
---
A message sent to a working `claude-agent` run now steers it mid-turn. Before, it waited for the turn's end, and a run whose whole job is one turn read it only after the work was done. The model now reads it at its next step, after the tool calls in flight finish, in the same turn. `POST /v2/runs/{id}/messages` answers mode `steer` for a working claude-agent run (it answered `follow_up`), and `GET /v2/capabilities` lists `claude-agent` with `steer: true`.
- The Timeline shows the message where the model read it: after the tool call it was sent during, never where it waited in the queue. Its command row is taken in that commit.
- A message sent as the turn ends starts the next turn, and the run ends only after that turn.
- A runner lost after it placed the message, before the model took it, neither loses it nor sends it twice. The next runner places nothing again, its resumed turn carries the message if the CLI never had it, and the message is on the Timeline once.
- A trigger's message that answers nothing (`answers: false`), and the answer to a question the run's last turn ended on, still run as turns of their own, as before.
- Adapters: `AdapterEvent` gains `message_taken` (`ids`): the submissions the model was given, for a host that keeps the run's record itself. `@parcha/agentrun-harness-claude`'s session implements `steer()`, places nothing again for an id it already holds, and says `message_taken`.
