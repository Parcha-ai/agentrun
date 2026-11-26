---
packages: @parcha/agentrun-serve, @parcha/agentrun
kind: breaking
---
On a server with no Docker box whose runner has no shell (Mode 1), a template update's `dry_run` is now refused for its place as its apply is. That is the `dry_run` of an apply with `agent_id`, the one `agentrun deploy` sends once its lock names the agent. Before, such a plan answered `revise`, `agentrun deploy` printed `~ agent ... revise` and asked to confirm, and the apply then failed with `422` `name a box`. The plan now checks the revision the update would write, so it is refused in the same field (`definition.place`), reason and words as the apply, and `agentrun deploy` stops at the preview. An example is a package that now names `bash`, for an agent with no place. A `dry_run` that lacks keys or a required MCP server lists them in its plan, as before, and checks the place only once they are there. That is the order the apply refuses in: `409` for the keys, then `422` for the place. Before, a fresh plan with keys missing and no place answered `422` for the place first.

Upgrading: an update of an agent made earlier keeps its place. An apply with `agent_id` of a package that names no `tools` writes the agent's revision with no tools, on the runner it had, where a fresh apply of the same package is refused.
