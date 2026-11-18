# Changelog

## [Unreleased]

- New package `@parcha/agentrun-harness-acp` (private for now): any Agent Client Protocol agent as a harness adapter, from a recipe that says how to start it over stdio, what it declares (`session/load`, MCP over HTTP or stdio), where it keeps its sessions and who bills its model. Built on the official `@agentclientprotocol/sdk` 2.7.0.
  - The agent runs in a private HOME with an environment allowlist (PATH, LANG, TZ and the recipe's own variables), in a process group of its own. Its session store is mirrored into the session's records, credential files left out, so another runner's agent loads it back.
  - The host's tools reach it as one loopback MCP server, over HTTP when it is declared and advertised, else stdio. Each call runs once through the kernel's tool bridge, under the agent's own tool call id.
  - A permission request for one of the agent's own tools (a shell, an edit) goes through the host's gate (allow, deny or park), is journaled, and survives a runner swap. The adapter answers `allow_once` or `reject_once` and never an `always` option. It never trusts the status ACP reports for a tool.
  - initialize is checked against the recipe: a capability the recipe declares and the agent does not advertise refuses the session with `ACP_CAPABILITY_MISMATCH`.
  - A plan-billed agent (its vendor bills the owner's plan, so no request reaches the host) is bounded by the adapter itself: the run stops at the recipe's `maxTurns` (`ACP_TURN_LIMIT`) or `maxToolCalls` (`ACP_TOOL_CALL_LIMIT`).
  - A crash mid-turn resumes with `session/load` when the agent has it, else on a new agent session that is given the conversation so far. Either way the agent reads the kernel's recovery note, and a call it started is never run again.
