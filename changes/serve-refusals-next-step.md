---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: fix
---
Every refusal and reason about places, boxes and the agent's home now names the next step.
- A place's `422` on `definition.place` carries a `fix`: the place it most likely meant, to copy (`"place": {"mode": "sandbox", "box": "docker"}` for `"place": "docker"` or `{"mode": "docker"}`), or the field to remove. `bash` on a runner agent gets the sandbox place as its fix; the browser in a sandbox, `Remove "browser" from definition.tools.`; a workflow in a sandbox, `"place": {"mode": "runner"}` (an edit that leaves the place out keeps the agent's).
- A box that `AGENTRUN_BOXES` does not list says `not enabled on this server: start AgentRun with AGENTRUN_BOXES=docker`, keeping the boxes the setting already lists. The same reason is in capabilities, a save's warning and a run's `409`.
- A `docker` whose daemon does not answer says `docker version failed (exit 1): start Docker, or add this server's user to the docker group, then restart this server`. A missing CLI says to install Docker. A save's warning and a run's `409` end in one full stop (no more `?.`).
- `capabilities.tools`' `bash` is `available: false`, with a `reason` naming each box's own, when no box this server has can run it.
- The start banner adds a line saying which boxes are ready (`Boxes: docker is ready, so sandbox agents run their tools there.`), or why none is. `startServe` returns it as `boxesLine`.
- A read under the home's `learning/` names `/v2/agents/{id}/learning` only on a server that has that route. Otherwise it says `the server keeps learning/ for itself; this server has no learning API yet`.
- The browser's sandbox refusal is in plain words.
- (`@parcha/pi-durable-agent`) A timeline row for a call answered only by the harness's diagnostics block (a tool that threw or is not offered) is summarized by its error (`Ran \`true\` failed: Tool bash is not available`), not by the block's `<harness>` tag.
