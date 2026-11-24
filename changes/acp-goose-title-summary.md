---
packages: @parcha/agentrun-harness-acp, @parcha/agentrun-serve
kind: fix
---
Goose 1.59.2 no longer asks permission for a call of one of AgentRun's tools, and the ACP adapter no longer reads Goose's titles. Before, it tied `agentrun: <tool>` (with or without Goose's summary, `agentrun: write · proof.txt`) to our tool and answered `allow_once`, and a title in a form it did not read reached the tool gate as Goose's own call and stopped the run at input_required.
- A recipe's new `allowFile` (`{ path, form }`) is written into the private HOME at each start from the tools that start lists. Goose's recipe declares its permission file, `.config/goose/permission.yaml` in the form `goose-permission`, every tool allowed as `agentrun__<tool>` and nothing else, so the gate asks once, at the MCP call.
- The adapter answers a permission request `allow_once` without the gate only where the recipe declares `quirks.permissionTie: "title"`: Cursor's recipe alone, since its allowlist asks for every MCP call. Every other request goes to the host's gate, journaled, whatever its title says.
- A call is matched to its MCP call by the tool's name and its arguments. Cursor's late update names its call by its `rawInput` (`providerIdentifier`, `toolName`), never by its title.
- `agentrun harness-check` matches a permission request to `check_echo` by the request's `toolCallId` or by `check_echo`'s arguments in its input, never by its title. Its `mcp_tool` row counts every request (`permissionAsks`) and those for `check_echo` (`ourAsks`); a request for the agent's own call fails no stage. A recipe file passes `allowFile` and `quirks` through.
