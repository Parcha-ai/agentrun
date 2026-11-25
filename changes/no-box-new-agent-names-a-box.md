---
packages: @parcha/agentrun-serve, @parcha/agentrun
kind: breaking
---
On a server without Docker's box, a new agent with no place is refused, never sent to the runner or to another box. A create that used to succeed now fails: an agentic definition that names no place and would get the Docker box (it names no tools, or names a shell tool such as `bash` or a background tool) is `422 input_invalid` at `definition.place`, with the message `name a box: this server has no Docker box for a new agent. Set place to {mode: sandbox, box: <one of: …>}, or to {mode: runner} to run without a shell.` The message lists the boxes this server has, or `<none is set up>`, and the `fix` says the same. Before, such an agent was saved with no place and ran on the runner with no shell. An edit that would save such a revision is refused the same way.
What to do: name the place, `"place": {"mode": "sandbox", "box": "<a box this server has>"}`, or `"place": {"mode": "runner"}` with no shell tool. To keep the runner without naming it, name the tools, with no shell tool among them (`"tools": []`, or `["read", "write"]`).
- The default box is Docker's, by its id. Another box that answers is never picked for a new agent.
- A run of an agent saved earlier with no place and a shell tool, once Docker is gone, is `409 agent_not_runnable` in the same words. That run was already refused; only the words change.
- In Mode 2, a shell tool the runner's own shell runs (`bash`, on Archil's serverless exec) needs no box. A new agent naming it alone, with no place, still saves.
- Unchanged: a workflow, a definition that names its place (the runner included), one whose tools need no shell, and a template apply, which names its tools.
- `capabilities.places.default_reason` now carries the refusal's words. Docker's own reason stays on its entry in `places.boxes`. The start's `Boxes:` line reads `Boxes: none, so a new agent must name its place: a box, or the runner.`, followed by Docker's reason.
- The console's place picker on a server with no box says to set one up for the agent, or choose On the server to run it without a shell. It no longer says the agent runs on the server. `agentrun doctor` says the same.
