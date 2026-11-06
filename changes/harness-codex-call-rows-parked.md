---
packages: @parcha/agentrun-serve, @parcha/agentrun-harness-codex, @parcha/agentrun-kernel
kind: fix
---
On codex and claude-agent, a tool call (a remote MCP server's included) has its Timeline row while it runs, from the moment the session records its intent, and a call a crash cut off gets its result row at the next open from the session's record of it: "interrupted ... it may or may not have taken effect" for one that is not safe to repeat. Before, a running call had no row, and a cut call never got one.
- On codex, a code-mode script's call the host parked for a person's approval (an MCP tool's or a host tool's) is never told to the model as completed: the cut script's output says it "was waiting for a person's approval and did not run". The host marks such an answer `parked` (`HostTool` and `McpCallResult`), which the MCP door never sends the harness's client.
